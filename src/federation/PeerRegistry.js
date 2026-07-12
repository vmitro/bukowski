// src/federation/PeerRegistry.js - Cross-process peer discovery
//
// Each bukowski advertises itself by writing ~/.bukowski/peers/<pid>.json,
// and watches the directory for siblings. This module is just discovery —
// no message transport yet (that's FederationHub, Phase 2). What it gives
// callers is:
//   - a resolved "host" name with collision handling (BUKOWSKI_HOST env
//     wins, then basename(cwd); appended with a 4-char pid hash if a live
//     peer is already using the same host)
//   - `peer:appeared` / `peer:gone` events as siblings come and go
//   - cleanup of stale peer files (dead PID, or PID alive but its fedSocket
//     is gone) on every scan
//
// Watcher debounces fs.watch bursts at 50ms; a 5s safety poll covers
// platforms where fs.watch silently no-ops (e.g. some WSL setups).

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { hostFromCwd, shortHash, machineHost } = require('../utils/host');

const DEFAULT_PEERS_DIR = path.join(os.homedir(), '.bukowski', 'peers');

// Static peers describe a bukowski on ANOTHER box whose fedSocket has been
// forwarded here over an SSH StreamLocalForward (see `bukowski --join`). Unlike
// pid peers they carry no local PID — their "liveness" is simply whether the
// forwarded socket is still present (the SSH tunnel holds it; teardown/
// StreamLocalBindUnlink removes it). So they live in a SEPARATE dir that the
// pid-liveness pruner never touches, and are surfaced only while their socket
// exists. File shape: { host, sessionId, fedSocket, static:true }.
const DEFAULT_STATIC_PEERS_DIR = path.join(os.homedir(), '.bukowski', 'peers.static');

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

class PeerRegistry extends EventEmitter {
  constructor(opts = {}) {
    super();

    this.peersDir = opts.peersDir || DEFAULT_PEERS_DIR;
    this.staticPeersDir = opts.staticPeersDir || DEFAULT_STATIC_PEERS_DIR;
    this.pid = opts.pid || process.pid;
    this.sessionId = opts.sessionId || null;
    this.ipcSocket = opts.ipcSocket || null;
    this.mcpSocket = opts.mcpSocket || null;
    this.fedSocket = opts.fedSocket || null;  // Filled in by Phase 2

    // Resolved host name (set in start() after collision check).
    this.host = null;
    this._baseHost = opts.host
      || hostFromCwd(process.env.BUKOWSKI_HOST || process.cwd());
    // Truthful machine identity, advertised alongside the cwd-derived routing
    // host so consumers can disambiguate two same-named boxes.
    this.machineHost = opts.machineHost || machineHost();

    this.peers = new Map();   // pid -> peerInfo
    this.peerFile = null;
    this.watcher = null;
    this._scanTimer = null;
    this._pollTimer = null;
    this._stopped = false;
  }

  /**
   * Initialize: ensure peers dir exists, prune stale files, resolve host,
   * write our own peer file, scan siblings, and start watching for changes.
   * Returns the resolved host name.
   */
  start() {
    fs.mkdirSync(this.peersDir, { recursive: true, mode: 0o700 });
    try { fs.mkdirSync(this.staticPeersDir, { recursive: true, mode: 0o700 }); }
    catch { /* static peers are optional; ignore if unavailable */ }
    this._prune();
    this.host = this._resolveHost();
    this.peerFile = path.join(this.peersDir, `${this.pid}.json`);
    this._writeOwnFile();
    this._scan();
    this._startWatcher();
    // Safety poll for platforms where fs.watch is unreliable. Cheap: a
    // single readdir + a few stat calls every 5 seconds.
    this._pollTimer = setInterval(() => this._scan(), 5000);
    if (this._pollTimer.unref) this._pollTimer.unref();
    // Belt-and-braces: TerminalManager's onShutdown only fires on SIGINT/
    // SIGTERM, so register a process-exit handler too. Sync unlink is
    // safe inside 'exit'. _exitHandler is detached in stop() so it
    // doesn't fire twice.
    this._exitHandler = () => {
      if (this._stopped) return;
      if (this.peerFile) {
        try { fs.unlinkSync(this.peerFile); } catch { /* ignore */ }
      }
      // Release the base-host claim so a future launch can reclaim the bare
      // name instead of being pushed to a suffix forever.
      if (this._hostLockPath) {
        try { fs.unlinkSync(this._hostLockPath); } catch { /* ignore */ }
      }
    };
    process.on('exit', this._exitHandler);
    return this.host;
  }

  /**
   * Tear down: stop the watcher and poll, unlink our peer file. Idempotent.
   */
  stop() {
    if (this._stopped) return;
    this._stopped = true;
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* ignore */ }
      this.watcher = null;
    }
    if (this.staticWatcher) {
      try { this.staticWatcher.close(); } catch { /* ignore */ }
      this.staticWatcher = null;
    }
    if (this._scanTimer) {
      clearTimeout(this._scanTimer);
      this._scanTimer = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this.peerFile) {
      try { fs.unlinkSync(this.peerFile); } catch { /* ignore */ }
    }
    if (this._hostLockPath) {
      try { fs.unlinkSync(this._hostLockPath); } catch { /* ignore */ }
      this._hostLockPath = null;
    }
    if (this._exitHandler) {
      try { process.removeListener('exit', this._exitHandler); } catch { /* ignore */ }
      this._exitHandler = null;
    }
  }

  /**
   * Update a piece of our advertised metadata (most commonly fedSocket once
   * FederationHub starts). Re-writes the peer file so siblings pick it up.
   */
  update(patch = {}) {
    if (this._stopped) return;
    for (const key of ['sessionId', 'ipcSocket', 'mcpSocket', 'fedSocket']) {
      if (key in patch) this[key] = patch[key];
    }
    this._writeOwnFile();
  }

  list() {
    return Array.from(this.peers.values());
  }

  getHost() { return this.host; }

  // ─────────────────────────────────────────────────────────────────────

  _writeOwnFile() {
    const info = {
      pid: this.pid,
      host: this.host,
      machineHost: this.machineHost,
      sessionId: this.sessionId,
      ipcSocket: this.ipcSocket,
      mcpSocket: this.mcpSocket,
      fedSocket: this.fedSocket,
      startedAt: this._startedAt || (this._startedAt = Date.now())
    };
    // Atomic write: a plain writeFileSync truncates first and then writes,
    // so a sibling reading the file mid-flight sees an empty / partial blob
    // and skips us in _resolveHost — collision detection then misses and
    // both ends up with the unsuffixed host. Write to a sibling temp file
    // and rename in place so readers always see either the previous state
    // or the new state, never a torn one.
    const tmp = `${this.peerFile}.${this.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
    try { fs.renameSync(tmp, this.peerFile); }
    catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw err;
    }
  }

  _readPeerFile(file) {
    const full = path.join(this.peersDir, file);
    try {
      return { full, info: JSON.parse(fs.readFileSync(full, 'utf-8')) };
    } catch {
      return { full, info: null };
    }
  }

  _prune() {
    let entries;
    try { entries = fs.readdirSync(this.peersDir); }
    catch { return; }

    for (const file of entries) {
      const pid = parseInt(file.replace(/\.json$/, ''), 10);
      if (!Number.isInteger(pid) || pid === this.pid) continue;

      const { full, info } = this._readPeerFile(file);
      if (!info) {
        // Unparseable: drop it.
        try { fs.unlinkSync(full); } catch { /* ignore */ }
        continue;
      }

      const dead = !isPidAlive(pid);
      const sockGone = info.fedSocket && !fs.existsSync(info.fedSocket);
      if (dead || sockGone) {
        try { fs.unlinkSync(full); } catch { /* ignore */ }
      }
    }
  }

  _resolveHost() {
    // Elect the owner of the bare base host through an atomic exclusive-create
    // lock, NOT a readdir scan. The scan alone races: _resolveHost runs before
    // _writeOwnFile (see start()), so two bukowskis launched in the same instant
    // each see an empty peers dir, both keep the bare base host, and both mint
    // identical federated ids (claude-<host>-N) — that is exactly what lands one
    // session's FIPA/event traffic in the other's queue and corrupts sender
    // attribution. An atomic O_EXCL create has no such window: whoever wins owns
    // <base>; every other live instance falls back to a pid-suffixed host that
    // is unique to it. resolvedHost is captured once by callers (multi.js), so
    // this MUST settle synchronously here — hence a lock, not a later reconcile.
    if (this._claimBaseHost(this._baseHost)) return this._baseHost;
    return `${this._baseHost}-${shortHash(this.pid)}`;
  }

  /**
   * Atomically claim ownership of the bare base host. Returns true if we own it.
   * The owner writes its pid into a lock file created with the 'wx' (O_CREAT|
   * O_EXCL) flag, so exactly one concurrent creator succeeds. If the lock is
   * already held we reclaim it only when the recorded owner is us or is dead
   * (unclean shutdown left a stale lock); a live foreign owner means we suffix.
   * @private
   */
  _claimBaseHost(base) {
    const lockPath = path.join(this.peersDir, `.host-${base}.owner`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(lockPath, 'wx'); // atomic create-or-fail
        try { fs.writeSync(fd, String(this.pid)); } finally { fs.closeSync(fd); }
        this._hostLockPath = lockPath;
        return true;
      } catch (err) {
        if (err.code !== 'EEXIST') return false; // unexpected fs error → suffix, stay safe
        let ownerPid = null;
        try { ownerPid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10); }
        catch { /* unreadable/racing writer */ }
        if (ownerPid === this.pid) { this._hostLockPath = lockPath; return true; }
        if (!Number.isInteger(ownerPid) || !isPidAlive(ownerPid)) {
          // Stale lock from a dead owner — drop it and retry the create.
          try { fs.unlinkSync(lockPath); } catch { /* another instance beat us to it */ }
          continue;
        }
        return false; // live foreign owner holds the base host → we suffix
      }
    }
    return false;
  }

  _scan() {
    if (this._stopped) return;

    let entries;
    try { entries = fs.readdirSync(this.peersDir); }
    catch { return; }

    const seen = new Set();
    for (const file of entries) {
      const pid = parseInt(file.replace(/\.json$/, ''), 10);
      if (!Number.isInteger(pid) || pid === this.pid) continue;
      if (!isPidAlive(pid)) continue;

      const { info } = this._readPeerFile(file);
      if (!info) continue;
      seen.add(pid);

      const prev = this.peers.get(pid);
      if (!prev) {
        this.peers.set(pid, info);
        this.emit('peer:appeared', info);
      } else if (
        prev.fedSocket !== info.fedSocket ||
        prev.mcpSocket !== info.mcpSocket ||
        prev.ipcSocket !== info.ipcSocket ||
        prev.host !== info.host
      ) {
        // Metadata changed (e.g. fedSocket just came up). Update silently
        // and emit a separate event so consumers can react if they want.
        this.peers.set(pid, info);
        this.emit('peer:updated', info);
      }
    }

    // Static (forwarded-over-SSH) peers share the same map + events but are
    // keyed by a string id so they never collide with integer pids.
    this._scanStatic(seen);

    for (const key of Array.from(this.peers.keys())) {
      if (!seen.has(key)) {
        const gone = this.peers.get(key);
        this.peers.delete(key);
        this.emit('peer:gone', gone);
      }
    }
  }

  /**
   * Scan the static-peers dir. Each valid file whose forwarded fedSocket
   * currently exists is surfaced as a peer keyed `static:<basename>`; when its
   * socket disappears (SSH tunnel dropped) it falls out of `seen` and the
   * caller's gone-loop emits peer:gone. No pid-liveness — these have no local
   * pid. Entries missing host/fedSocket are skipped (dial() needs both).
   * @param {Set} seen - accumulates live keys for the caller's gone-detection
   * @private
   */
  _scanStatic(seen) {
    let entries;
    try { entries = fs.readdirSync(this.staticPeersDir); }
    catch { return; }

    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      let info;
      try {
        info = JSON.parse(fs.readFileSync(path.join(this.staticPeersDir, file), 'utf-8'));
      } catch { continue; }
      if (!info || !info.host || !info.fedSocket) continue;
      // Liveness = the forwarded socket is present. A dropped tunnel (with
      // StreamLocalBindUnlink) removes it, so the peer ages out on next scan.
      if (!fs.existsSync(info.fedSocket)) continue;
      info.static = true;

      const key = `static:${file.replace(/\.json$/, '')}`;
      seen.add(key);
      const prev = this.peers.get(key);
      if (!prev) {
        this.peers.set(key, info);
        this.emit('peer:appeared', info);
      } else if (
        prev.fedSocket !== info.fedSocket ||
        prev.host !== info.host ||
        prev.sessionId !== info.sessionId
      ) {
        this.peers.set(key, info);
        this.emit('peer:updated', info);
      }
    }
  }

  _startWatcher() {
    try {
      this.watcher = fs.watch(this.peersDir, () => {
        if (this._scanTimer || this._stopped) return;
        this._scanTimer = setTimeout(() => {
          this._scanTimer = null;
          this._scan();
        }, 50);
      });
      this.watcher.on('error', (err) => this.emit('error', err));
    } catch (err) {
      // Watcher couldn't be created — the 5s poll covers us.
      this.emit('error', err);
    }
    // Watch the static dir too so a `--join` peer file appears/vanishes
    // promptly. Best-effort; the 5s safety poll is the real guarantee.
    try {
      this.staticWatcher = fs.watch(this.staticPeersDir, () => {
        if (this._scanTimer || this._stopped) return;
        this._scanTimer = setTimeout(() => {
          this._scanTimer = null;
          this._scan();
        }, 50);
      });
      this.staticWatcher.on('error', () => { /* poll covers it */ });
    } catch { /* dir may not exist; poll covers it */ }
  }
}

module.exports = { PeerRegistry, DEFAULT_PEERS_DIR, DEFAULT_STATIC_PEERS_DIR };
