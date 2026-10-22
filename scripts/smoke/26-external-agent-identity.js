#!/usr/bin/env node
/**
 * External bridge identity must survive a reconnect.
 *
 * An external agent (codex, gemini, a bare claude REPL) has no pane, so its
 * name is minted by the instance at `initialize` time. The counter behind that
 * ran forward on every handshake — and a bridge re-handshakes far more often
 * than it is created: it outlives the instance it was bound to, because codex's
 * app-server-daemon owns the process rather than the pane, and the reconnect
 * loop re-attaches it the moment an instance returns.
 *
 * So one codex in ~/projects walked codex-projects-1 .. -5 over a day, four of
 * them pointing at nothing. Anyone still addressing an earlier name wrote to a
 * seat that had been deleted on close. That is what "the session lost its
 * connection mid-session" looked like from the outside: the socket was healthy
 * and the name was stale.
 */

const { EventEmitter } = require('events');
const { spawn, spawnSync } = require('child_process');
const { MCPServer } = require('../../src/mcp/MCPServer');

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}`); }
}

/** Enough socket for `initialize`: it writes one line and registers a close. */
class FakeSocket extends EventEmitter {
  constructor() { super(); this.written = []; }
  write(s) { this.written.push(s); return true; }
  lastResult() {
    const last = this.written[this.written.length - 1];
    return last ? JSON.parse(last).result : null;
  }
  close() { this.emit('close'); }
}

function newServer() {
  // No panes: every connection falls through to the external-agent path, which
  // is the one under test.
  return new MCPServer({ getAllAgents: () => [] }, null, null, null);
}

/** Drive a bridge handshake exactly as src/mcp/bukowski-mcp-bridge.js does. */
async function connectBridge(server, { pid, cwd, agentType = 'codex' }) {
  const socket = new FakeSocket();
  const clientState = { agentId: null, buffer: '' };
  await server._handleRequest(socket, clientState, {
    jsonrpc: '2.0',
    id: '__init__',
    method: 'initialize',
    params: { agentType, agentId: null, pid, cwd, ancestorPids: [pid] },
  });
  return { socket, clientState, id: socket.lastResult()?.assignedAgentId };
}

const CWD = '/home/sheemeh/projects';

// Real pids, because the server deliberately holds a name only while the
// process that earned it is alive (block 6). Fabricated pid numbers would be
// read as dead bridges and the reuse under test would never happen.
const sleepers = [];
function livePid() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  sleepers.push(child);
  return child.pid;
}
function reapSleepers() {
  for (const c of sleepers) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
}

async function run() {
  console.log('1. a fresh bridge is named after its origin directory');
  let server = newServer();
  const bridgePid = livePid();
  const first = await connectBridge(server, { pid: bridgePid, cwd: CWD });
  ok(first.id === 'codex-projects-1', `first codex in ~/projects is codex-projects-1 (got ${first.id})`);
  ok(first.clientState.agentId === 'codex-projects-1', 'and the connection carries that id');

  console.log('2. the same bridge process keeps its name across a reconnect');
  first.socket.close();
  ok(server.getExternalAgents().length === 0, 'the dropped link deregisters the seat');
  const again = await connectBridge(server, { pid: bridgePid, cwd: CWD });
  ok(again.id === 'codex-projects-1', `reconnect reuses the name (got ${again.id})`);
  ok(server.getExternalAgents().length === 1, 'and re-registers exactly one seat');

  console.log('3. an instance restart does not walk the counter');
  // The observed history: four reconnects over one day.
  let last = again;
  for (let i = 0; i < 4; i++) {
    last.socket.close();
    last = await connectBridge(server, { pid: bridgePid, cwd: CWD });
  }
  ok(last.id === 'codex-projects-1', `still codex-projects-1 after five handshakes (got ${last.id})`);
  ok(server.getExternalAgents().length === 1, 'and there is one seat, not five');
  ok(!server.getExternalAgents().some((a) => a.id.endsWith('-5')),
    'no codex-projects-5 — the name nobody could address');

  console.log('4. genuinely different bridges still get different names');
  const other = await connectBridge(server, { pid: livePid(), cwd: CWD });
  ok(other.id === 'codex-projects-2', `a second bridge process is codex-projects-2 (got ${other.id})`);
  const elsewhere = await connectBridge(server, { pid: livePid(), cwd: '/home/sheemeh/projects/azra-agent' });
  ok(elsewhere.id === 'codex-azra-agent-1', `another directory starts its own count (got ${elsewhere.id})`);
  const claude = await connectBridge(server, { pid: livePid(), cwd: CWD, agentType: 'claude' });
  ok(claude.id === 'claude-projects-1', `another type starts its own count (got ${claude.id})`);
  ok(server.getExternalAgents().length === 4, 'four live bridges, four seats');

  console.log('5. a late close cannot evict the registration that replaced it');
  // A reconnect can be fully handshaked before the OLD socket's close event is
  // delivered. The old close must not take the live seat down with it.
  const racingPid = livePid();
  const stale = await connectBridge(server, { pid: racingPid, cwd: CWD });
  const fresh = await connectBridge(server, { pid: racingPid, cwd: CWD });
  ok(fresh.id === stale.id, 'both handshakes answer with the same name');
  stale.socket.close();
  ok(server.getExternalAgents().some((a) => a.id === fresh.id),
    'the seat survives the stale close');
  fresh.socket.close();
  ok(!server.getExternalAgents().some((a) => a.id === fresh.id),
    'and goes away when the live socket closes');

  console.log('6. a name is held for the bridge, not forever');
  server = newServer();
  const dead = spawnSync(process.execPath, ['-e', '']).pid;   // exited before we look
  const gone = await connectBridge(server, { pid: dead, cwd: CWD });
  ok(gone.id === 'codex-projects-1', 'it is named like any other bridge while connected');
  gone.socket.close();
  const next = await connectBridge(server, { pid: livePid(), cwd: CWD });
  ok(next.id === 'codex-projects-2',
    `a dead bridge's name is not handed to a different process (got ${next.id})`);

  console.log('7. a bridge too old to report its pid is unaffected');
  server = newServer();
  const legacy1 = await connectBridge(server, { pid: undefined, cwd: CWD });
  legacy1.socket.close();
  const legacy2 = await connectBridge(server, { pid: undefined, cwd: CWD });
  ok(legacy1.id === 'codex-projects-1' && legacy2.id === 'codex-projects-2',
    'no pid, no reuse — the old behaviour, not a crash');
}

run().then(() => {
  reapSleepers();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('OK: external agent identity smoke passed');
}).catch((err) => {
  reapSleepers();
  console.log(`  FAIL ${err.stack}`);
  process.exit(1);
});
