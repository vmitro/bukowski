#!/usr/bin/env node
// External-bridge-agent federation smoke. Regression guard for the gap where
// codex/gemini agents — which connect purely through the MCP bridge (no pty,
// no session pane) — were excluded from the federation roster: peers could
// route TO them but never learned of THEM, so list_agents omitted them and
// replies failed "Unknown agent".
//
// We spawn two bukowskis (shared fake HOME so they discover each other),
// connect a fake EXTERNAL codex agent to one instance's MCP socket exactly as
// the bridge does (initialize with agentType+cwd, no agentId), then probe that
// instance's FederationHub hello and assert its local roster now includes the
// external agent's federated id.
//
// This validates snapshotLocalRoster()'s external-agent branch. Cross-peer
// delta propagation (announceLocalAgent on connect) ships the same record over
// the wire and isn't separately probe-asserted here.

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
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bukowski-smoke-extfed-home-'));
const PEERS_DIR = path.join(FAKE_HOME, '.bukowski', 'peers');
const SOCKETS_DIR = path.join(FAKE_HOME, '.bukowski', 'sockets');

function cleanup(procs) {
  for (const p of procs || []) { try { p.kill('SIGKILL'); } catch {} }
  try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch {}
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

function spawnBukowski(host) {
  return pty.spawn('node', [path.join(REPO, 'multi.js')], {
    name: 'xterm-256color', cols: 140, rows: 30, cwd: REPO,
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

function fail(msg, extra) {
  console.error('FAIL:', msg);
  if (extra) console.error(extra);
  cleanup(procs);
  process.exit(1);
}

function readJsonDir(dir, namePattern) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (namePattern && !namePattern.test(f)) continue;
    try { out.push({ name: f, body: fs.readFileSync(path.join(dir, f), 'utf-8').trim() }); }
    catch { /* ignore */ }
  }
  return out;
}

// Connect to an MCP socket and run the bridge's initialize handshake as an
// external agent. Resolves { socket, assignedAgentId } — keeps the socket OPEN
// (the server drops external agents from its roster on socket close).
function connectExternalAgent(socketPath, agentType, cwd, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '', done = false;
    const timer = setTimeout(() => { if (!done) { done = true; sock.destroy(); reject(new Error('mcp init timed out')); } }, timeoutMs);
    sock.on('error', (err) => { if (!done) { done = true; clearTimeout(timer); reject(err); } });
    sock.on('connect', () => {
      sock.write(JSON.stringify({
        jsonrpc: '2.0', id: '__init__', method: 'initialize',
        params: { agentType, agentId: null, cwd }
      }) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      let msg;
      try { msg = JSON.parse(buf.slice(0, idx)); } catch { return; }
      if (msg.id !== '__init__') return;
      clearTimeout(timer);
      done = true;
      const assignedAgentId = msg.result?.assignedAgentId;
      if (!assignedAgentId) { sock.destroy(); return reject(new Error('no assignedAgentId in init result')); }
      resolve({ socket: sock, assignedAgentId });
    });
  });
}

// Probe a FederationHub hello and return its advertised local roster.
function probeRoster(socketPath, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '', done = false;
    const finish = (err, res) => { if (done) return; done = true; try { sock.destroy(); } catch {} err ? reject(err) : resolve(res); };
    const timer = setTimeout(() => finish(new Error('fed probe timed out')), timeoutMs);
    sock.on('error', (err) => finish(err));
    sock.on('connect', () => sock.write(JSON.stringify({ type: 'hello', host: 'smoke-zzzz', sessionId: 'smoke', startedAt: Date.now() }) + '\n'));
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      let msg;
      try { msg = JSON.parse(buf.slice(0, idx)); } catch { return finish(new Error('non-JSON hello')); }
      clearTimeout(timer);
      if (msg.type !== 'hello') return finish(new Error(`non-hello: ${msg.type}`));
      finish(null, { host: msg.host, agents: msg.agents || [] });
    });
  });
}

(async () => {
  await new Promise((r) => setTimeout(r, BOOT_WAIT_MS));

  if (aExited || bExited) {
    return fail(`a bukowski exited prematurely (a=${aExited}, b=${bExited})`,
                'A tail: ' + stripAnsi(aBuf).slice(-1200) + '\n--\nB tail: ' + stripAnsi(bBuf).slice(-1200));
  }

  // Correlate pid -> { host, fedSocket, mcpSocket } via the peer files and the
  // sockets discovery files (both keyed by the bukowski's pid).
  const peers = readJsonDir(PEERS_DIR, /^\d+\.json$/).map(e => JSON.parse(e.body));
  const mcpByPid = Object.fromEntries(readJsonDir(SOCKETS_DIR, /^\d+$/).map(e => [e.name, e.body]));
  const byHost = {};
  for (const p of peers) {
    byHost[p.host] = { host: p.host, fedSocket: p.fedSocket, mcpSocket: mcpByPid[String(p.pid)] };
  }
  if (!byHost.azra || !byHost.azra.mcpSocket) {
    return fail('could not resolve azra mcp socket', JSON.stringify({ peers, mcpByPid }, null, 2));
  }
  if (!byHost.azra.fedSocket || !fs.existsSync(byHost.azra.fedSocket)) {
    return fail('azra fedSocket missing');
  }

  // Connect a fake external codex agent to azra. cwd basename becomes the host
  // segment of its assigned id, so it lands as codex-azra-agent-1.
  let ext;
  try { ext = await connectExternalAgent(byHost.azra.mcpSocket, 'codex', '/tmp/azra-agent'); }
  catch (e) { return fail('external agent init failed: ' + e.message); }

  if (!/^codex-azra-agent-\d+$/.test(ext.assignedAgentId)) {
    ext.socket.destroy();
    return fail(`unexpected assigned id: ${ext.assignedAgentId}`);
  }

  // Give the connect a beat to register, then read azra's local roster.
  await new Promise((r) => setTimeout(r, 500));

  let roster;
  try { roster = await probeRoster(byHost.azra.fedSocket); }
  catch (e) { ext.socket.destroy(); return fail('fed probe failed: ' + e.message); }

  const found = roster.agents.find(x => x.federatedId === ext.assignedAgentId);
  if (!found) {
    ext.socket.destroy();
    return fail(`external agent ${ext.assignedAgentId} NOT in azra roster`,
                'roster: ' + JSON.stringify(roster.agents, null, 2));
  }
  if (found.type !== 'codex') {
    ext.socket.destroy();
    return fail(`external agent in roster has wrong type: ${found.type}`);
  }

  console.log(`mcp:    external agent registered as ${ext.assignedAgentId}`);
  console.log(`roster: azra advertises ${roster.agents.length} agent(s), includes ${found.federatedId} (type=${found.type})`);

  ext.socket.destroy();
  a.kill('SIGINT');
  b.kill('SIGINT');
  await new Promise((r) => setTimeout(r, 1500));
  cleanup(procs);
  console.log('OK: external-agent federation smoke passed');
  process.exit(0);
})();
