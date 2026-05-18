#!/usr/bin/env node
// Two-process federation smoke. Spawns two bukowski instances under a
// shared fake HOME (so they share ~/.bukowski/peers/) with different
// BUKOWSKI_HOST values, lets them discover each other, and asserts:
//
//   1. Both processes wrote their peer files with valid fedSockets.
//   2. Each peer's fedSocket file exists on disk.
//   3. Each bukowski's FederationHub answers an inbound hello from a
//      smoke-test identity, replies with its own hello, and includes
//      its roster — proving the handshake protocol is wired up end to
//      end through multi.js's startup, not just in unit tests.
//
// (1) and (2) prove discovery + advertise. (3) proves the wire.
//
// We do NOT scrape the chat pane: the default layout fills the visible
// area with the spawned agent (Claude Code's onboarding), so the chat
// surface isn't reliably visible without sending UI keystrokes.

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

let pty;
try { pty = require('node-pty'); }
catch (err) {
  console.error('SKIP: node-pty not installed:', err.message);
  process.exit(0);
}

const REPO = path.resolve(__dirname, '..', '..');
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bukowski-smoke-fed-home-'));
const PEERS_DIR = path.join(FAKE_HOME, '.bukowski', 'peers');

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

function cleanup(procs) {
  for (const p of procs || []) { try { p.kill('SIGKILL'); } catch {} }
  try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch {}
}

function spawnBukowski(host) {
  return pty.spawn('node', [path.join(REPO, 'multi.js')], {
    name: 'xterm-256color',
    cols: 140,
    rows: 30,
    cwd: REPO,
    env: { ...process.env, HOME: FAKE_HOME, BUKOWSKI_HOST: host }
  });
}

const a = spawnBukowski('azra');
const b = spawnBukowski('vladimir');
const procs = [a, b];

let aBuf = '', bBuf = '';
a.on('data', (d) => { aBuf += d.toString(); });
b.on('data', (d) => { bBuf += d.toString(); });

let aExited = false, bExited = false;
a.on('exit', () => { aExited = true; });
b.on('exit', () => { bExited = true; });

const BOOT_WAIT_MS = 6000;
const QUIT_WAIT_MS = 4000;

function fail(msg, extra) {
  console.error('FAIL:', msg);
  if (extra) console.error(extra);
  cleanup(procs);
  process.exit(1);
}

function readPeerFiles() {
  if (!fs.existsSync(PEERS_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(PEERS_DIR)) {
    if (!/^\d+\.json$/.test(f)) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(PEERS_DIR, f), 'utf-8')));
    } catch { /* ignore */ }
  }
  return out;
}

/**
 * Probe a FederationHub by dialing its socket, sending a hello as a
 * 'smoke-aaaa' fake-host identity, and waiting for the hub's hello back.
 * Resolves with { peerHost, peerSessionId, agents } or rejects on timeout.
 */
function probeHandshake(socketPath, label, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    let done = false;
    const finish = (err, result) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      if (err) reject(err); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error(`probe ${label} timed out`)), timeoutMs);
    sock.on('error', (err) => finish(new Error(`probe ${label} socket error: ${err.message}`)));
    sock.on('connect', () => {
      // smoke-zzzz so it sorts AFTER any real host name — guarantees the
      // hub treats us as the lex-smaller side and replies. (Actually the
      // hub replies regardless once it accepts; this is belt-and-braces.)
      sock.write(JSON.stringify({
        type: 'hello',
        host: 'smoke-zzzz',
        sessionId: 'smoke-test',
        startedAt: Date.now()
      }) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      const line = buf.slice(0, idx);
      let msg;
      try { msg = JSON.parse(line); }
      catch (e) { return finish(new Error(`probe ${label} got non-JSON: ${line.slice(0, 80)}`)); }
      clearTimeout(timer);
      if (msg.type !== 'hello') {
        return finish(new Error(`probe ${label} got non-hello: ${msg.type}`));
      }
      finish(null, { peerHost: msg.host, peerSessionId: msg.sessionId, agents: msg.agents || [] });
    });
  });
}

(async () => {
  await new Promise((r) => setTimeout(r, BOOT_WAIT_MS));

  // Check 1+2: disk state.
  if (aExited || bExited) {
    return fail(`one of the bukowskis exited prematurely (aExited=${aExited}, bExited=${bExited})`,
                'A tail: ' + stripAnsi(aBuf).slice(-1500) + '\n--\nB tail: ' + stripAnsi(bBuf).slice(-1500));
  }

  const peers = readPeerFiles();
  if (peers.length !== 2) {
    return fail(`expected 2 peer files, found ${peers.length}`, JSON.stringify(peers, null, 2));
  }
  const byHost = Object.fromEntries(peers.map(p => [p.host, p]));
  if (!byHost.azra || !byHost.vladimir) {
    return fail(`expected hosts azra+vladimir, got ${peers.map(p => p.host).join(',')}`);
  }
  for (const h of ['azra', 'vladimir']) {
    const p = byHost[h];
    if (!p.fedSocket) return fail(`peer ${h} has no fedSocket`);
    if (!fs.existsSync(p.fedSocket)) return fail(`fedSocket missing on disk for ${h}: ${p.fedSocket}`);
  }

  // Check 3: live handshake probe against each side's FederationHub.
  let probeA, probeB;
  try { probeA = await probeHandshake(byHost.azra.fedSocket,     'azra'); }
  catch (e) { return fail(e.message); }
  try { probeB = await probeHandshake(byHost.vladimir.fedSocket, 'vladimir'); }
  catch (e) { return fail(e.message); }

  if (probeA.peerHost !== 'azra') {
    return fail(`azra fedSocket replied with host=${probeA.peerHost}`);
  }
  if (probeB.peerHost !== 'vladimir') {
    return fail(`vladimir fedSocket replied with host=${probeB.peerHost}`);
  }

  console.log('disk:   2 peer files with live fedSockets');
  console.log(`probe:  azra hello -> host=${probeA.peerHost}, ${probeA.agents.length} agent(s) in roster`);
  console.log(`probe:  vladimir hello -> host=${probeB.peerHost}, ${probeB.agents.length} agent(s) in roster`);

  // Tear down.
  a.kill('SIGINT');
  b.kill('SIGINT');

  const deadline = Date.now() + QUIT_WAIT_MS;
  while (Date.now() < deadline) {
    if (aExited && bExited) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!aExited || !bExited) {
    console.error('WARN: one side did not exit within ' + QUIT_WAIT_MS + 'ms; force-killing');
    cleanup(procs);
  } else {
    cleanup([]);
  }
  console.log('OK: federation smoke passed');
  process.exit(0);
})();
