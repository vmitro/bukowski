#!/usr/bin/env node
// Dashboard end-to-end smoke. Proves the project-dashboard MCP tools work over
// the real bridge → MCPServer → DashboardStore path, that governance is
// enforced by caller identity, that a mutation fires an out-of-turn <channel>
// signal to participants, and that the on-disk Markdown is human-cat-able.
//
// Two REAL bukowski-mcp-bridge.js processes stand in as agents (that's exactly
// what a Claude pane connects through). One full bukowski provides the live
// MCPServer + DashboardStore. The spawned bukowski's curator id is set to
// claude-alice-1 so alice can create projects.
//
//   1. Spawn bukowski under a fake HOME with BUKOWSKI_DASHBOARD_CURATOR_ID.
//   2. Connect bridge alice (claude-alice-1) + bob (claude-bob-1).
//   3. alice (curator) creates a project spanning repos alice + bob.
//   4. bob receives the dashboard.changed channel signal.
//   5. bob (owner) sets a tasks entry; alice sees it via dashboard_digest.
//   6. Governance: bob cannot write alice's repo (NOT_RESPONSIBLE).
//   7. On-disk tasks.md is cat-able, one-liner + refs only.
//   8. dashboard_chain walks a ref.
//
// Skips if node-pty is unavailable (dev install).

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let pty;
try { pty = require('node-pty'); }
catch (err) { console.error('SKIP: node-pty not installed:', err.message); process.exit(0); }

const REPO = path.resolve(__dirname, '..', '..');
const BRIDGE = path.join(REPO, 'src', 'mcp', 'bukowski-mcp-bridge.js');
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bukowski-dash-home-'));
const DIR_ALICE = path.join(FAKE_HOME, 'alice');
const DIR_BOB = path.join(FAKE_HOME, 'bob');
fs.mkdirSync(DIR_ALICE, { recursive: true });
fs.mkdirSync(DIR_BOB, { recursive: true });

const procs = [];
function cleanup() {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch {}
}
function fail(msg, extra) {
  console.error('FAIL:', msg);
  if (extra) console.error(extra);
  cleanup();
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('BUKOWSKI_')) env[k] = v;
  }
  return { ...env, HOME: FAKE_HOME, ...extra };
}

let socketPath = null;

function makeBridge(cwd, agentType = 'claude') {
  const child = spawn('node', [BRIDGE], {
    cwd,
    env: cleanEnv({ BUKOWSKI_MCP_SOCKET: socketPath, BUKOWSKI_AGENT_TYPE: agentType }),
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  procs.push(child);
  const client = { child, messages: [], buf: '', nextId: 100 };
  child.stdout.on('data', (d) => {
    client.buf += d.toString();
    const lines = client.buf.split('\n');
    client.buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { client.messages.push(JSON.parse(line)); } catch { /* ignore */ }
    }
  });
  client.send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
  return client;
}

async function waitFor(client, pred, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = pred(client.messages);
    if (hit) return hit;
    await sleep(50);
  }
  fail(`timed out waiting for ${what}`, 'messages: ' + JSON.stringify(client.messages.slice(-6), null, 2));
}

// Call a dashboard/* (or any) tool and return the parsed tool result, or throw
// the tagged error. Consumes the response so later calls see a fresh id.
async function call(client, name, args) {
  const id = client.nextId++;
  client.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const resp = await waitFor(client, (m) => m.find((x) => x.id === id), 4000, `${name} response`);
  client.messages = client.messages.filter((x) => x.id !== id);
  const text = resp.result?.content?.[0]?.text || '';
  if (resp.result?.isError) {
    const m = /DASHBOARD_ERROR (\{.*\})/.exec(text);
    const err = new Error(text);
    err.code = m ? JSON.parse(m[1]).code : null;
    throw err;
  }
  try { return JSON.parse(text); } catch { return text; }
}

const buko = pty.spawn('node', [path.join(REPO, 'multi.js')], {
  name: 'xterm-256color', cols: 120, rows: 30, cwd: REPO,
  env: cleanEnv({ BUKOWSKI_HOST: 'dashtest', BUKOWSKI_DASHBOARD_CURATOR_ID: 'claude-alice-1' }),
});
procs.push(buko);
let bukoBuf = '';
buko.on('data', (d) => { bukoBuf += d.toString(); });

(async () => {
  // 1. Wait for the MCP socket discovery file.
  const legacy = path.join(FAKE_HOME, '.bukowski-mcp-socket');
  const bootDeadline = Date.now() + 10000;
  while (Date.now() < bootDeadline) {
    try {
      const p = fs.readFileSync(legacy, 'utf-8').trim();
      if (p && fs.existsSync(p)) { socketPath = p; break; }
    } catch { /* not yet */ }
    await sleep(150);
  }
  if (!socketPath) fail('bukowski never published an MCP socket', bukoBuf.slice(-1500));

  // 2. Connect alice + bob, run the init handshake.
  const alice = makeBridge(DIR_ALICE);
  const bob = makeBridge(DIR_BOB);
  for (const c of [alice, bob]) {
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }
  await waitFor(alice, (m) => m.find((x) => x.id === 1 && x.result), 4000, 'alice initialize');
  await waitFor(bob, (m) => m.find((x) => x.id === 1 && x.result), 4000, 'bob initialize');

  // 3. Poll list_agents until both external agents registered.
  let ready = false;
  const regDeadline = Date.now() + 6000;
  while (Date.now() < regDeadline) {
    const agents = await call(alice, 'list_agents', {});
    const ids = (agents || []).map((a) => a.id);
    if (ids.includes('claude-alice-1') && ids.includes('claude-bob-1')) { ready = true; break; }
    await sleep(250);
  }
  if (!ready) fail('bridge agents never registered (claude-alice-1 / claude-bob-1)');
  console.log('registered: claude-alice-1, claude-bob-1');

  // 4. alice (curator) creates a project spanning both repos.
  const beforeBob = bob.messages.length;
  const created = await call(alice, 'dashboard_create_project', {
    name: 'Judge Bench',
    goal: 'openai-4o agent drives the android app live on device',
    repos: [{ repo: 'alice', root: DIR_ALICE }, { repo: 'bob', root: DIR_BOB }],
  });
  if (created.projectId !== 'judge-bench') fail('unexpected project id', JSON.stringify(created));
  console.log(`created project: ${created.projectId} (rev ${created.rev})`);

  // 5. bob receives the dashboard.changed channel signal (participant, not the mutator).
  const ping = await waitFor(
    bob,
    (m) => m.slice(beforeBob).find((x) => x.method === 'notifications/claude/channel'
      && (x.params?.content || '').includes('dashboard.changed')),
    4000,
    'dashboard.changed channel signal on bob',
  );
  if ((ping.params?.meta?.sender) !== 'claude-alice-1') fail('signal sender wrong', JSON.stringify(ping.params?.meta));
  console.log('bob received the dashboard.changed channel signal from claude-alice-1');

  // 6. bob (owner of repo "bob") sets a tasks entry; refs required (actionable).
  const setRes = await call(bob, 'dashboard_set_entry', {
    projectId: 'judge-bench', repo: 'bob', category: 'tasks',
    oneliner: 'wire ChannelClient.subscribeAwaitAck into the harness',
    refs: ['bob://sha/b57d25f', 'conv:687b00cb'],
  });
  if (!setRes.entryId) fail('set_entry returned no entryId', JSON.stringify(setRes));
  console.log(`bob set entry ${setRes.entryId}`);

  // 7. alice sees bob's entry via digest.
  const dig = await call(alice, 'dashboard_digest', { projectId: 'judge-bench' });
  if (!dig.digest.includes('subscribeAwaitAck')) fail('alice digest missing bob entry', dig.digest);
  console.log('alice digest includes bob\'s entry');

  // 8. Governance: bob cannot write alice's repo.
  let denied = false;
  try {
    await call(bob, 'dashboard_set_entry', { projectId: 'judge-bench', repo: 'alice', category: 'bugs', oneliner: 'x', refs: ['alice://sha/1'] });
  } catch (e) { denied = e.code === 'NOT_RESPONSIBLE'; }
  if (!denied) fail('bob was allowed to write alice\'s repo (should be NOT_RESPONSIBLE)');
  console.log('governance: bob denied write to alice\'s repo (NOT_RESPONSIBLE)');

  // 9. On-disk Markdown is cat-able: one-liner + refs only, no bodies, <=80.
  const tasksMd = fs.readFileSync(path.join(FAKE_HOME, '.bukowski', 'dashboard', 'judge-bench', 'tasks.md'), 'utf-8');
  if (!tasksMd.includes('subscribeAwaitAck') || !tasksMd.includes('bob://sha/b57d25f')) {
    fail('tasks.md missing entry/refs', tasksMd);
  }
  for (const line of tasksMd.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const m = line.match(/^\S+\s+\[[^\]]+\]\s+(.*?)(\s+::.*)?$/);
    if (m && m[1].length > 80) fail('on-disk one-liner exceeds 80 chars', m[1]);
  }
  console.log('tasks.md is cat-able (one-liner + refs, capped):');
  console.log('  ' + tasksMd.split('\n').find((l) => l.includes('subscribeAwaitAck')));

  // 10. Causal chain walk from a ref.
  const chain = await call(alice, 'dashboard_chain', { fromRef: 'bob://sha/b57d25f' });
  if (!chain.chain || !chain.chain.some((n) => n.ref === 'bob://sha/b57d25f')) {
    fail('dashboard_chain did not return the ref', JSON.stringify(chain));
  }
  console.log('dashboard_chain walked from bob://sha/b57d25f');

  console.log('OK: dashboard e2e smoke passed');
  buko.kill('SIGINT');
  await sleep(500);
  cleanup();
  process.exit(0);
})().catch((e) => fail('unexpected error: ' + (e.stack || e.message)));
