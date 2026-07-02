// src/federation/sshJoin.js — federate two bukowskis across the internet over
// one SSH connection, no relay server.
//
// bukowski federation is a Unix-socket duplex (FederationHub listens on
// /tmp/bukowski-fed-<pid>.sock; peers dial each other's socket, discovered via
// ~/.bukowski/peers). Unix sockets are local, so cross-box needs a tunnel. SSH
// already gives us one: a StreamLocalForward carries a Unix socket over the
// wire. We set up BOTH directions on a single ssh connection —
//
//   -R <remoteSock>:<ourFedSocket>   → our hub appears on the peer (peer dials us)
//   -L <localSock>:<peerFedSocket>   → the peer's hub appears here (we dial it)
//
// — then drop a STATIC peer file on each side (PeerRegistry static peers, exempt
// from pid-liveness pruning) pointing at the forwarded socket. From there the
// existing dial()/shouldDial()/dedup machinery links the two hubs unchanged;
// whichever side shouldDial picks has a real socket to reach.
//
// Liveness is the tunnel: while ssh holds the forwards the sockets exist and the
// peers are live; on drop the sockets vanish and both registries age the peer
// out. We reconnect with backoff until stopped.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATIC_DIR = path.join(os.homedir(), '.bukowski', 'peers.static');
// Forwarded sockets live in /tmp on both ends: absolute (StreamLocalForward
// needs absolute remote paths) and free of any assumption about the remote
// user's home directory.
const FWD_PREFIX = '/tmp/bukowski-join';
const REMOTE_STATIC_DIR = '.bukowski/peers.static'; // relative to remote $HOME

/**
 * Parse a join endpoint into an ssh target + optional port.
 * Accepts: "host", "user@host", "user@host:port", or an ssh_config alias.
 * The ":port" suffix is split off (ssh takes it via -p, not in the target).
 * @param {string} str
 * @returns {{ sshTarget: string, port: number|null, label: string }}
 */
function parseEndpoint(str) {
  let rest = String(str || '').trim();
  let port = null;
  const m = rest.match(/^(.+):(\d+)$/);
  if (m) { rest = m[1]; port = parseInt(m[2], 10); }
  // A filesystem-safe label for naming forwarded sockets / static files.
  const label = rest.replace(/[^A-Za-z0-9_.-]/g, '_') || 'peer';
  return { sshTarget: rest, port, label };
}

/**
 * Split a blob of concatenated JSON objects (`}{`, optionally newline-
 * separated — what `cat ~/.bukowski/peers/*.json` produces) into parsed
 * objects. Walks brace depth so it tolerates the missing separators and any
 * whitespace between objects.
 * @param {string} blob
 * @returns {object[]}
 */
function parseConcatenatedJson(blob) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < blob.length; i++) {
    const c = blob[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try { out.push(JSON.parse(blob.slice(start, i + 1))); } catch { /* skip */ }
        start = -1;
      }
    }
  }
  return out;
}

/**
 * Build the ssh argv for the bidirectional forward. Pure — returned array is
 * exactly what gets spawned, so it's unit-testable without a network.
 * @param {object} o
 * @param {string} o.sshTarget            ssh destination (alias or user@host)
 * @param {number|null} o.port            ssh port, or null for default
 * @param {string} o.ourFedSocket         our local FederationHub socket
 * @param {string} o.peerFedSocket        peer's FederationHub socket (its box)
 * @param {string} o.remoteSock           where our socket is exposed on the peer (-R bind)
 * @param {string} o.localSock            where the peer's socket is exposed here (-L bind)
 * @returns {string[]}
 */
function buildSshArgs(o) {
  const args = [
    '-N',                                   // no remote command, just forwards
    '-o', 'ExitOnForwardFailure=yes',       // die (→ reconnect) if a bind fails
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StreamLocalBindUnlink=yes',      // reclaim a stale LOCAL (-L) bind
    '-o', 'BatchMode=yes',                  // never hang on a prompt
  ];
  if (o.port) args.push('-p', String(o.port));
  args.push('-R', `${o.remoteSock}:${o.ourFedSocket}`);
  args.push('-L', `${o.localSock}:${o.peerFedSocket}`);
  args.push(o.sshTarget);
  return args;
}

/**
 * Orchestrates one `--join` link: discover the peer, wire the tunnel + static
 * peers, and keep it up with backoff until stop().
 */
class SshJoin {
  /**
   * @param {object} opts
   * @param {string} opts.endpoint                   join endpoint string
   * @param {{host,sessionId,fedSocket}} opts.local  our own advertised identity
   * @param {(msg:string)=>void} [opts.log]          status sink
   */
  constructor(opts) {
    this.endpoint = opts.endpoint;
    this.local = opts.local;
    this.log = opts.log || (() => {});
    this._ep = parseEndpoint(opts.endpoint);
    this.child = null;
    this._stopped = false;
    this._backoffMs = 1000;
    this._localStaticFile = null;
    this._remoteStaticName = null;
    this._remoteSock = null;
  }

  _ssh(extraArgs, input) {
    const base = [];
    if (this._ep.port) base.push('-p', String(this._ep.port));
    base.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10');
    return execFileSync('ssh', [...base, this._ep.sshTarget, ...extraArgs], {
      input: input || undefined, encoding: 'utf8', timeout: 15000,
    });
  }

  /** Read the peer box's own peer files and pick the live federation hub. */
  _discoverPeerHub() {
    const blob = this._ssh(['for f in ~/.bukowski/peers/*.json; do cat "$f"; echo; done']);
    const hubs = parseConcatenatedJson(blob).filter(p => p && p.fedSocket && p.host);
    if (!hubs.length) throw new Error('no bukowski with a fedSocket found on peer');
    // Newest wins if several instances are up on the peer box.
    hubs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return hubs[0];
  }

  start() {
    let hub;
    try {
      hub = this._discoverPeerHub();
    } catch (err) {
      this.log(`join ${this.endpoint}: discovery failed — ${err.message}`);
      return false;
    }

    const ourHost = this.local.host;
    this._remoteSock = `${FWD_PREFIX}-${ourHost}.sock`;              // -R bind on peer
    const localSock = `${FWD_PREFIX}-${this._ep.label}-${process.pid}.sock`; // -L bind here

    // Static peer file HERE → our registry dials the peer via the -L socket.
    fs.mkdirSync(STATIC_DIR, { recursive: true, mode: 0o700 });
    this._localStaticFile = path.join(STATIC_DIR, `${this._ep.label}.json`);
    fs.writeFileSync(this._localStaticFile, JSON.stringify({
      host: hub.host, sessionId: hub.sessionId, fedSocket: localSock, static: true,
    }, null, 2), { mode: 0o600 });

    // Static peer file on the PEER → its registry dials us via the -R socket.
    this._remoteStaticName = `${ourHost}.json`;
    const remoteJson = JSON.stringify({
      host: ourHost, sessionId: this.local.sessionId, fedSocket: this._remoteSock, static: true,
    });
    try {
      // Pre-clean a stale -R socket (server may lack StreamLocalBindUnlink) and
      // plant our static file on the peer.
      this._ssh([
        `mkdir -p ~/${REMOTE_STATIC_DIR}`,
        `&& rm -f ${this._remoteSock}`,
        `&& cat > ~/${REMOTE_STATIC_DIR}/${this._remoteStaticName}`,
      ], remoteJson);
    } catch (err) {
      this.log(`join ${this.endpoint}: could not stage peer — ${err.message}`);
      this._cleanupLocal();
      return false;
    }

    this._sshArgs = buildSshArgs({
      sshTarget: this._ep.sshTarget, port: this._ep.port,
      ourFedSocket: this.local.fedSocket, peerFedSocket: hub.fedSocket,
      remoteSock: this._remoteSock, localSock,
    });
    this._peerHost = hub.host;
    this._spawnTunnel();
    this.log(`join ${this.endpoint}: linking ${ourHost} ↔ ${hub.host} over SSH`);
    return true;
  }

  _spawnTunnel() {
    if (this._stopped) return;
    this.child = spawn('ssh', this._sshArgs, { stdio: ['ignore', 'ignore', 'ignore'] });
    this.child.on('exit', () => {
      this.child = null;
      if (this._stopped) return;
      // Backoff reconnect, capped at 30s.
      const wait = this._backoffMs;
      this._backoffMs = Math.min(this._backoffMs * 2, 30000);
      this.log(`join ${this.endpoint}: tunnel down, reconnecting in ${Math.round(wait / 1000)}s`);
      this._reconnectTimer = setTimeout(() => this._spawnTunnel(), wait);
      if (this._reconnectTimer.unref) this._reconnectTimer.unref();
    });
    // A tunnel that stays up for 10s is healthy → reset backoff.
    this._stableTimer = setTimeout(() => { this._backoffMs = 1000; }, 10000);
    if (this._stableTimer.unref) this._stableTimer.unref();
  }

  _cleanupLocal() {
    if (this._localStaticFile) {
      try { fs.unlinkSync(this._localStaticFile); } catch { /* ignore */ }
      this._localStaticFile = null;
    }
  }

  /** Tear down: kill the tunnel, remove both static peer files + the -R socket. */
  stop() {
    if (this._stopped) return;
    this._stopped = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._stableTimer) clearTimeout(this._stableTimer);
    if (this.child) { try { this.child.kill(); } catch { /* ignore */ } this.child = null; }
    this._cleanupLocal();
    if (this._remoteStaticName) {
      try {
        this._ssh([
          `rm -f ~/${REMOTE_STATIC_DIR}/${this._remoteStaticName} ${this._remoteSock}`,
        ]);
      } catch { /* best effort; peer ages it out when the socket dies anyway */ }
    }
  }
}

module.exports = { SshJoin, parseEndpoint, parseConcatenatedJson, buildSshArgs, STATIC_DIR };
