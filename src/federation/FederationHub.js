// src/federation/FederationHub.js - Cross-process transport between bukowskis
//
// Phase 2 of federation: just the wire. Each bukowski listens on
// /tmp/bukowski-fed-<pid>.sock and dials its siblings (discovered via
// PeerRegistry). Two bukowskis end up with exactly one duplex connection.
//
// Wire protocol (newline-delimited JSON, same shape as IPCHub):
//   { type:'hello',     host, sessionId, startedAt, agents:[...] }
//   { type:'roster',    op:'add'|'remove', agent }
//   { type:'forward',   from, to, message, hops:[host,...] }
//   { type:'heartbeat', ts }
//
// Dial deduplication: when both A and B discover each other, only the side
// with the lexicographically smaller host dials. On host tie, sessionId
// tiebreaks. The accepting side rejects a second connection from a host
// it's already connected to. The handshake-completion event fires once per
// pair regardless of which side dialed.
//
// roster/forward are surfaced as events but FederationHub itself does
// nothing with their contents — that's Phase 3 (agent registry) and Phase
// 4 (IPCHub routing integration).

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');

const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_TIMEOUT_MS = 45000;
const HELLO_TIMEOUT_MS = 5000;

function defaultSocketPath(pid) {
  return path.join('/tmp', `bukowski-fed-${pid}.sock`);
}

/**
 * Strict-less comparison for two (host, sessionId) tuples. Used to decide
 * which side of a pair dials. Returns true iff `a` should dial `b`.
 */
function shouldDial(aHost, aSessionId, bHost, bSessionId) {
  if (aHost === bHost) {
    // Same host (shouldn't happen post collision-resolution, but defensive).
    // Fall back to sessionId so exactly one side dials.
    return String(aSessionId || '') < String(bSessionId || '');
  }
  return aHost < bHost;
}

class FederationHub extends EventEmitter {
  constructor(opts = {}) {
    super();

    if (!opts.host) throw new Error('FederationHub: host is required');

    this.host = opts.host;
    this.sessionId = opts.sessionId || null;
    this.startedAt = opts.startedAt || Date.now();
    this.peerRegistry = opts.peerRegistry || null;
    this.socketPath = opts.socketPath || defaultSocketPath(process.pid);

    // Callback returning our current federatable roster as
    // [{ localId, type, federatedId }]. Caller decides what to include
    // (typically session agents minus chat-tabs / external bridges).
    this.getLocalRoster = opts.getLocalRoster || (() => []);

    // host -> { socket, direction, sessionId, lastSeen, hbTimer, hbCheckTimer, helloSent }
    this.peers = new Map();
    // federatedId -> { peerHost, localTargetId, type }
    this.remoteAgents = new Map();
    // Sockets that have connected but haven't sent a hello yet.
    this.pendingInbound = new Set();
    // Outbound dial attempts in flight: host -> socket
    this.dialing = new Map();

    this.server = null;
    this._registryHandlers = null;
    this._stopped = false;
  }

  /**
   * Start the listen socket. Returns the socket path so callers can
   * advertise it (PeerRegistry.update).
   */
  async start() {
    // Clean up any leftover socket file from a previous crashed process.
    try { fs.unlinkSync(this.socketPath); } catch { /* ignore */ }

    await new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this._handleInbound(socket));
      this.server.on('error', (err) => this.emit('error', err));
      this.server.listen(this.socketPath, () => {
        try { fs.chmodSync(this.socketPath, 0o600); } catch { /* ignore */ }
        resolve();
      });
      this.server.once('error', reject);
    });

    if (this.peerRegistry) this._attachRegistry();
    return this.socketPath;
  }

  /**
   * Tear down: close all peer sockets and the listen socket, unlink the
   * socket file. Idempotent.
   */
  stop() {
    if (this._stopped) return;
    this._stopped = true;

    this._detachRegistry();

    for (const peer of this.peers.values()) {
      this._teardownPeer(peer, 'shutdown');
    }
    this.peers.clear();

    for (const sock of this.pendingInbound) {
      try { sock.destroy(); } catch { /* ignore */ }
    }
    this.pendingInbound.clear();

    for (const sock of this.dialing.values()) {
      try { sock.destroy(); } catch { /* ignore */ }
    }
    this.dialing.clear();

    if (this.server) {
      try { this.server.close(); } catch { /* ignore */ }
      this.server = null;
    }

    try { fs.unlinkSync(this.socketPath); } catch { /* ignore */ }
  }

  /**
   * Send a roster delta to every connected peer. `agent` is
   * { localId, type, federatedId }.
   */
  broadcastRoster(op, agent) {
    const msg = { type: 'roster', op, agent };
    for (const peer of this.peers.values()) {
      this._send(peer, msg);
    }
  }

  /**
   * Push our CURRENT full local roster to one peer as roster:add deltas.
   * The hello carries a point-in-time snapshot, so an agent that wasn't yet
   * federatable when the handshake ran (e.g. a restored-session agent whose
   * pty spawns late, or one added before the agent:added listener was wired)
   * is missing from the peer's view with no other way to appear. Re-sending
   * the live snapshot on connect heals that; ingest is idempotent (keyed by
   * federatedId on the receiver).
   * @private
   */
  _syncRosterTo(peer) {
    for (const agent of this._localRosterSnapshot()) {
      this._send(peer, { type: 'roster', op: 'add', agent });
    }
  }

  /**
   * Re-broadcast our current full local roster to every connected peer. A
   * cheap self-healing gossip: any announce/hello that raced a link (re)connect
   * or an agent's pty coming up is reconciled on the next call. Callers run it
   * on a slow timer so a peer's list_agents converges even when the delta path
   * missed an agent. Idempotent on receivers.
   */
  resyncRoster() {
    const snapshot = this._localRosterSnapshot();
    if (!snapshot.length) return;
    for (const peer of this.peers.values()) {
      for (const agent of snapshot) {
        this._send(peer, { type: 'roster', op: 'add', agent });
      }
    }
  }

  /**
   * Fan a locally-published coordination event out to every connected peer.
   * `ev` is the EventBus event record { topic, payload, actor, host, ts, seq }.
   * `hops` carries the origin-host path for loop suppression in a multi-peer
   * mesh — a peer that sees its own host already in hops drops the event
   * instead of re-fanning it (same guard the FIPA 'forward' path uses).
   * Delivery is best-effort at-least-once; consumer idempotence covers dupes,
   * which beats exactly-once machinery at coordination-event volume.
   */
  broadcastEvent(ev, hops) {
    const msg = { type: 'event', event: ev, hops: Array.isArray(hops) && hops.length ? hops : [this.host] };
    for (const peer of this.peers.values()) this._send(peer, msg);
  }

  /**
   * Announce a newly-added local agent to all peers. Caller passes the
   * federated form so FederationHub doesn't need to know naming rules.
   */
  announceLocalAgent(agent) {
    if (!agent || !agent.federatedId) return;
    this.broadcastRoster('add', agent);
  }

  /**
   * Announce a removed local agent.
   */
  announceLocalRemoval(agent) {
    if (!agent || !agent.federatedId) return;
    this.broadcastRoster('remove', agent);
  }

  /**
   * Look up a federated agent ID; returns { peerHost, localTargetId, type }
   * or null. Used by IPCHub to decide whether a non-local target is
   * routable via federation.
   */
  resolveRemote(federatedId) {
    return this.remoteAgents.get(federatedId) || null;
  }

  /**
   * Look up a federated id that belongs to one of OUR OWN agents; returns
   * the agent's local id or null. Local agents are advertised to peers
   * under these aliases (claude-<host>-N), so agents learn them from
   * list_agents output / peer chatter and use them as FIPA targets even
   * when the target lives on the very same instance — without this lookup
   * such a send fails "Unknown agent" although the id is the one the
   * federation itself advertises.
   */
  resolveLocalAlias(federatedId) {
    if (!federatedId) return null;
    const hit = this._localRosterSnapshot().find(a => a.federatedId === federatedId);
    return hit ? hit.localId : null;
  }

  /**
   * Forward map: a local agent id (claude-1) -> its federated alias
   * (claude-<host>-N). The inverse of resolveLocalAlias. Coordination events
   * must travel under the federated id so a topic/actor minted on one box does
   * not collide with a same-numbered local agent on another box. Returns null
   * if the id isn't one of our own local agents (caller falls back to the id
   * as-given).
   */
  federatedIdFor(localId) {
    if (!localId) return null;
    const hit = this._localRosterSnapshot().find(a => a.localId === localId);
    return hit ? hit.federatedId : null;
  }

  /**
   * Forward an IPC-shape message to its federated recipient. The message
   * carries the agent-level `from`/`to` already in their federated forms
   * (caller's responsibility); FederationHub rewrites `to` down to the
   * peer's local id before sending, and stashes the original federated id
   * in `_federatedTo` so the receiver can verify the forward was actually
   * meant for an agent on its side (matters when two peers share local
   * agent names like "claude-1" — without the hint a misrouted forward
   * would be silently claimed by the wrong claude-1).
   *
   * Returns true if the peer is connected and the write was attempted.
   */
  forwardIpcMessage(ipcMessage) {
    if (!ipcMessage || !ipcMessage.to) return false;
    const remote = this.remoteAgents.get(ipcMessage.to);
    if (!remote) return false;

    const rewritten = {
      ...ipcMessage,
      to: remote.localTargetId,
      _federatedTo: ipcMessage.to
    };
    return this.forwardTo(remote.peerHost, { ipcMessage: rewritten });
  }

  /**
   * Forward a message to a specific peer host. Returns true if the peer is
   * connected and the write was attempted, false otherwise. Loop protection
   * via `hops` is enforced on receive, not here.
   */
  forwardTo(host, payload) {
    const peer = this.peers.get(host);
    if (!peer) return false;
    const message = { type: 'forward', ...payload };
    if (!Array.isArray(message.hops)) message.hops = [];
    if (!message.hops.includes(this.host)) message.hops.push(this.host);
    return this._send(peer, message);
  }

  /**
   * List currently connected peer hosts.
   */
  connectedHosts() {
    return Array.from(this.peers.keys());
  }

  // ─────────────────────────────────────────────────────────────────────
  // Inbound: accept a connection, wait for hello, register or reject.

  _handleInbound(socket) {
    if (this._stopped) {
      socket.destroy();
      return;
    }
    this.pendingInbound.add(socket);
    socket.setNoDelay(true);

    const state = { buffer: '', host: null, helloTimer: null, adopted: false };

    state.helloTimer = setTimeout(() => {
      // Peer never sent a hello — drop.
      this.pendingInbound.delete(socket);
      try { socket.destroy(); } catch { /* ignore */ }
    }, HELLO_TIMEOUT_MS);

    // Pre-adoption listeners. _adoptInbound removes them once it transfers
    // ownership to _registerPeer, otherwise this handler would interpret
    // subsequent application messages as "protocol violation: not hello"
    // and tear down the perfectly good connection.
    state.onData = (chunk) => {
      if (state.adopted) return;
      state.buffer += chunk.toString('utf8');
      this._consumePendingBuffer(socket, state);
    };
    state.onClose = () => {
      if (state.adopted) return;
      this.pendingInbound.delete(socket);
      if (state.helloTimer) clearTimeout(state.helloTimer);
    };
    state.onError = state.onClose;

    socket.on('data', state.onData);
    socket.on('error', state.onError);
    socket.on('close', state.onClose);
    socket._pendingState = state;  // _adoptInbound uses this to detach.
  }

  _consumePendingBuffer(socket, state) {
    let idx;
    while ((idx = state.buffer.indexOf('\n')) !== -1) {
      const line = state.buffer.slice(0, idx);
      state.buffer = state.buffer.slice(idx + 1);
      if (!line.trim()) continue;

      let msg;
      try { msg = JSON.parse(line); }
      catch { continue; }

      if (msg.type !== 'hello') {
        // Protocol violation: first message must be hello.
        try { socket.destroy(); } catch { /* ignore */ }
        this.pendingInbound.delete(socket);
        if (state.helloTimer) clearTimeout(state.helloTimer);
        return;
      }

      clearTimeout(state.helloTimer);
      this.pendingInbound.delete(socket);
      this._adoptInbound(socket, msg, state.buffer);
      return;  // _adoptInbound takes ownership; rest of buffer handed off.
    }
  }

  _adoptInbound(socket, hello, leftoverBuffer) {
    const peerHost = hello.host;
    const peerSessionId = hello.sessionId || null;

    if (!peerHost) {
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }

    if (peerHost === this.host) {
      // Connected to ourselves — drop.
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }

    if (this.peers.has(peerHost)) {
      // Already connected. This is the duplicate-dial case: keep the
      // existing one, drop the newcomer.
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }

    // Cancel any in-flight outbound dial to this host — peer beat us to it.
    const pending = this.dialing.get(peerHost);
    if (pending) {
      try { pending.destroy(); } catch { /* ignore */ }
      this.dialing.delete(peerHost);
    }

    // Detach pre-adoption listeners so the established peer's own handlers
    // get sole control of the socket. Without this the pre-adoption data
    // handler would see subsequent app messages and tear the socket down.
    const ps = socket._pendingState;
    if (ps) {
      ps.adopted = true;
      try { socket.removeListener('data', ps.onData); } catch { /* ignore */ }
      try { socket.removeListener('close', ps.onClose); } catch { /* ignore */ }
      try { socket.removeListener('error', ps.onError); } catch { /* ignore */ }
      socket._pendingState = null;
    }

    const peer = this._registerPeer(socket, peerHost, peerSessionId, 'inbound', hello, !!hello.local);
    this._ingestPeerRoster(peerHost, hello.agents);
    // Reply with our hello FIRST (the dialer's pre-adoption reader accepts only
    // a hello as the first message); THEN push our live roster.
    this._sendHello(peer);
    this._syncRosterTo(peer);
    // Any bytes that arrived after the hello line are queued on the socket
    // buffer — process them now.
    if (leftoverBuffer && leftoverBuffer.length > 0) {
      peer._stream.buffer = leftoverBuffer;
      this._consumeEstablishedBuffer(peer);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Outbound: dial a peer's fedSocket, send hello, wait for their hello.

  dial(peerInfo) {
    if (this._stopped) return;
    if (!peerInfo || !peerInfo.fedSocket) return;
    if (!peerInfo.host || peerInfo.host === this.host) return;
    if (this.peers.has(peerInfo.host)) return;
    if (this.dialing.has(peerInfo.host)) return;

    if (!shouldDial(this.host, this.sessionId, peerInfo.host, peerInfo.sessionId)) {
      return;  // Other side dials.
    }

    if (!fs.existsSync(peerInfo.fedSocket)) return;

    const socket = net.createConnection(peerInfo.fedSocket);
    socket.setNoDelay(true);
    this.dialing.set(peerInfo.host, socket);

    const state = { buffer: '', helloTimer: null, adopted: false };

    socket.once('connect', () => {
      // Send hello first; then wait for theirs. Roster ships in hello so
      // the peer's remoteAgents map is populated on the same handshake.
      this._writeRaw(socket, {
        type: 'hello',
        host: this.host,
        sessionId: this.sessionId,
        startedAt: this.startedAt,
        // Same-box pid peer (not an SSH-forwarded static peer) → local link.
        // Locality is symmetric, so the accepter trusts this flag to decide
        // whether to skip its heartbeat-timeout teardown.
        local: !peerInfo.static,
        agents: this._localRosterSnapshot()
      });

      state.helloTimer = setTimeout(() => {
        this.dialing.delete(peerInfo.host);
        try { socket.destroy(); } catch { /* ignore */ }
      }, HELLO_TIMEOUT_MS);
    });

    // Pre-adoption data handler: consumes ONLY the peer's hello, then
    // hands off the socket. Subsequent chunks must reach the established
    // peer handler in _registerPeer; we detach this listener on adoption.
    state.onData = (chunk) => {
      if (state.adopted) return;
      state.buffer += chunk.toString('utf8');

      const idx = state.buffer.indexOf('\n');
      if (idx === -1) return;
      const line = state.buffer.slice(0, idx);
      state.buffer = state.buffer.slice(idx + 1);

      let msg;
      try { msg = JSON.parse(line); }
      catch {
        this.dialing.delete(peerInfo.host);
        try { socket.destroy(); } catch { /* ignore */ }
        return;
      }

      if (msg.type !== 'hello') {
        this.dialing.delete(peerInfo.host);
        try { socket.destroy(); } catch { /* ignore */ }
        return;
      }

      clearTimeout(state.helloTimer);
      this.dialing.delete(peerInfo.host);

      if (msg.host !== peerInfo.host) {
        this.emit('warning', { kind: 'host_mismatch', expected: peerInfo.host, got: msg.host });
      }

      if (this.peers.has(msg.host)) {
        try { socket.destroy(); } catch { /* ignore */ }
        return;
      }

      // Detach our pre-adoption listeners before _registerPeer attaches
      // its own — otherwise we'd consume bytes meant for the established
      // peer handler.
      state.adopted = true;
      try { socket.removeListener('data', state.onData); } catch { /* ignore */ }
      try { socket.removeListener('close', state.onClose); } catch { /* ignore */ }
      try { socket.removeListener('error', state.onError); } catch { /* ignore */ }

      const peer = this._registerPeer(socket, msg.host, msg.sessionId || null, 'outbound', msg, !peerInfo.static);
      this._ingestPeerRoster(msg.host, msg.agents);
      // We already sent our hello at connect; now push our live roster.
      this._syncRosterTo(peer);
      if (state.buffer.length > 0) {
        peer._stream.buffer = state.buffer;
        this._consumeEstablishedBuffer(peer);
      }
    };

    state.onError = () => {
      if (state.adopted) return;
      this.dialing.delete(peerInfo.host);
      if (state.helloTimer) clearTimeout(state.helloTimer);
    };
    state.onClose = () => {
      if (state.adopted) return;
      this.dialing.delete(peerInfo.host);
      if (state.helloTimer) clearTimeout(state.helloTimer);
    };

    socket.on('data', state.onData);
    socket.on('error', state.onError);
    socket.on('close', state.onClose);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Established connection: track peer, set up data handler + heartbeat.

  _registerPeer(socket, host, sessionId, direction, hello, local = false) {
    const peer = {
      host,
      sessionId,
      direction,
      socket,
      hello,
      local,
      lastSeen: Date.now(),
      hbTimer: null,
      hbCheckTimer: null,
      _stream: { buffer: '' }
    };

    socket.on('data', (chunk) => {
      peer._stream.buffer += chunk.toString('utf8');
      this._consumeEstablishedBuffer(peer);
    });

    socket.on('error', () => this._teardownPeer(peer, 'error'));
    socket.on('close', () => this._teardownPeer(peer, 'close'));

    peer.hbTimer = setInterval(() => {
      this._send(peer, { type: 'heartbeat', ts: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);
    if (peer.hbTimer.unref) peer.hbTimer.unref();

    // A LOCAL peer is a same-box instance reached over a real unix socket.
    // When such a peer's process dies the kernel closes the socket at once
    // ('close'/'error' above tears it down immediately) — there is no network
    // in between, so a half-open silent-but-alive socket does not happen. The
    // heartbeat-timeout teardown then only ever fires as a FALSE positive when
    // the peer's event loop stalls under load (RAM thrash, a busy medd fleet),
    // purging a live peer and dropping all its agents until it reconnects. So
    // for local peers we trust the socket lifecycle and skip the timeout kill;
    // we still emit a warning so a genuinely wedged local peer is visible.
    peer.hbCheckTimer = setInterval(() => {
      if (Date.now() - peer.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        if (peer.local) {
          this.emit('warning', {
            kind: 'local_peer_silent',
            host: peer.host,
            silentMs: Date.now() - peer.lastSeen
          });
          return;
        }
        this._teardownPeer(peer, 'heartbeat_timeout');
      }
    }, HEARTBEAT_INTERVAL_MS);
    if (peer.hbCheckTimer.unref) peer.hbCheckTimer.unref();

    this.peers.set(host, peer);
    this.emit('peer:connected', { host, sessionId, direction, hello });
    // Roster is synced by the CALLER, AFTER the hello handshake reply — NEVER
    // here. Syncing inline made _registerPeer emit roster deltas before the
    // reply hello; the peer's pre-adoption reader rejects any first message that
    // isn't 'hello' (destroys the socket), so the mesh never links once an
    // instance actually has an agent to sync. Hello-first is mandatory.
    return peer;
  }

  _consumeEstablishedBuffer(peer) {
    let idx;
    while ((idx = peer._stream.buffer.indexOf('\n')) !== -1) {
      const line = peer._stream.buffer.slice(0, idx);
      peer._stream.buffer = peer._stream.buffer.slice(idx + 1);
      if (!line.trim()) continue;

      let msg;
      try { msg = JSON.parse(line); }
      catch { continue; }

      peer.lastSeen = Date.now();

      switch (msg.type) {
        case 'heartbeat':
          // lastSeen updated above; nothing else to do.
          break;
        case 'roster': {
          if (msg.op === 'add' && msg.agent?.federatedId && msg.agent?.localId) {
            this.remoteAgents.set(msg.agent.federatedId, {
              peerHost: peer.host,
              localTargetId: msg.agent.localId,
              type: msg.agent.type || null
            });
          } else if (msg.op === 'remove' && msg.agent?.federatedId) {
            this.remoteAgents.delete(msg.agent.federatedId);
          }
          this.emit('roster', { from: peer.host, op: msg.op, agent: msg.agent });
          break;
        }
        case 'forward': {
          if (Array.isArray(msg.hops) && msg.hops.includes(this.host)) {
            // Loop: drop.
            break;
          }
          this.emit('forward', { from: peer.host, payload: msg });
          break;
        }
        case 'event': {
          const hops = Array.isArray(msg.hops) ? msg.hops : [];
          if (hops.includes(this.host)) break; // mesh loop: already saw this
          // Surface for local injection; carry hops so a re-fan (if the host
          // chooses to relay across a >2-node mesh) keeps loop suppression.
          this.emit('event', { from: peer.host, event: msg.event, hops });
          break;
        }
        case 'hello':
          // Unexpected mid-stream hello — ignore.
          break;
        default:
          this.emit('unknown', { from: peer.host, msg });
      }
    }
  }

  _teardownPeer(peer, reason) {
    if (!peer || peer._tornDown) return;
    peer._tornDown = true;

    if (peer.hbTimer) clearInterval(peer.hbTimer);
    if (peer.hbCheckTimer) clearInterval(peer.hbCheckTimer);

    try { peer.socket.destroy(); } catch { /* ignore */ }

    if (this.peers.get(peer.host) === peer) {
      this.peers.delete(peer.host);
    }
    // Drop any of this peer's agents from the remote registry so future
    // routes through them fail fast instead of timing out.
    this._purgePeerRoster(peer.host);
    this.emit('peer:disconnected', { host: peer.host, reason });
  }

  _sendHello(peer) {
    this._send(peer, {
      type: 'hello',
      host: this.host,
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      agents: this._localRosterSnapshot()
    });
  }

  _localRosterSnapshot() {
    try {
      const roster = this.getLocalRoster() || [];
      return roster
        .filter(a => a && a.localId && a.federatedId)
        .map(a => ({ localId: a.localId, type: a.type || null, federatedId: a.federatedId }));
    } catch {
      return [];
    }
  }

  _ingestPeerRoster(peerHost, agents) {
    if (!Array.isArray(agents)) return;
    for (const entry of agents) {
      if (!entry || !entry.federatedId || !entry.localId) continue;
      this.remoteAgents.set(entry.federatedId, {
        peerHost,
        localTargetId: entry.localId,
        type: entry.type || null
      });
    }
  }

  _purgePeerRoster(peerHost) {
    for (const [fid, info] of Array.from(this.remoteAgents.entries())) {
      if (info.peerHost === peerHost) this.remoteAgents.delete(fid);
    }
  }

  _send(peer, message) {
    if (!peer || !peer.socket || peer.socket.destroyed) return false;
    try {
      peer.socket.write(JSON.stringify(message) + '\n');
      return true;
    } catch {
      this._teardownPeer(peer, 'write_error');
      return false;
    }
  }

  _writeRaw(socket, message) {
    try {
      socket.write(JSON.stringify(message) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // PeerRegistry wiring.

  _attachRegistry() {
    if (!this.peerRegistry) return;
    const r = this.peerRegistry;

    const onAppeared = (peer) => this._maybeDial(peer);
    const onUpdated = (peer) => {
      // A static peer whose sessionId changed = the remote hub restarted (new
      // pid/session behind the same forwarded socket). The stale connection is
      // still in this.peers, so _maybeDial would bail ("already connected") and
      // never re-dial the live hub. Drop the stale peer first so the dial below
      // reconnects to the restarted session.
      const existing = this.peers.get(peer.host);
      if (existing && existing.sessionId && peer.sessionId && existing.sessionId !== peer.sessionId) {
        this._teardownPeer(existing, 'peer_session_changed');
      }
      this._maybeDial(peer);
    };
    const onGone = (peer) => {
      const existing = this.peers.get(peer.host);
      if (existing) this._teardownPeer(existing, 'peer_gone');
    };

    r.on('peer:appeared', onAppeared);
    r.on('peer:updated', onUpdated);
    r.on('peer:gone', onGone);

    this._registryHandlers = { onAppeared, onUpdated, onGone };

    // Dial any already-known peers (registry may have scanned before we
    // attached).
    for (const peer of r.list()) this._maybeDial(peer);
  }

  _detachRegistry() {
    if (!this.peerRegistry || !this._registryHandlers) return;
    const r = this.peerRegistry;
    const { onAppeared, onUpdated, onGone } = this._registryHandlers;
    r.off('peer:appeared', onAppeared);
    r.off('peer:updated', onUpdated);
    r.off('peer:gone', onGone);
    this._registryHandlers = null;
  }

  _maybeDial(peer) {
    if (this._stopped) return;
    if (!peer || !peer.fedSocket) return;          // Phase 1-only peer
    if (peer.host === this.host) return;
    if (this.peers.has(peer.host)) return;          // already connected
    if (this.dialing.has(peer.host)) return;        // dial in flight
    if (!shouldDial(this.host, this.sessionId, peer.host, peer.sessionId)) return;
    this.dial(peer);
  }
}

module.exports = { FederationHub, shouldDial, defaultSocketPath };
