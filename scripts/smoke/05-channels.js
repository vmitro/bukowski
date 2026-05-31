#!/usr/bin/env node
// Channel-push smoke. Proves that a FIPA message to an agent produces a
// notifications/claude/channel push that actually reaches that agent's MCP
// client over stdio — the whole point of channel delivery.
//
// We can't drive two real authenticated Claude Code TUIs here, so we stand in
// two REAL bukowski-mcp-bridge.js processes as the agents (that's exactly what
// a Claude pane connects through). One full bukowski instance provides the live
// MCPServer + FIPAHub wiring. Then:
//
//   1. Spawn bukowski under a fake HOME, read its MCP socket path.
//   2. Connect bridge "alice" (cwd basename -> claude-alice-1) and bridge
//      "bob" (claude-bob-1). Both register as external agents.
//   3. alice calls fipa_request { to: claude-bob-1, action: "<sentinel>" }.
//   4. Scan bob's bridge stdout for notifications/claude/channel carrying the
//      sentinel and meta.sender = claude-alice-1.
//
// Pass: bob receives the channel ping with the right content+meta and no `id`
// (notifications must omit it). Fail otherwise.
//
// Skips if node-pty is unavailable (dev install).

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

let pty;
try { pty = require('node-pty'); }
catch (err) {
  console.error('SKIP: node-pty not installed:', err.message);
  process.exit(0);
}

const REPO = path.resolve(__dirname, '..', '..');
const BRIDGE = path.join(REPO, 'src', 'mcp', 'bukowski-mcp-bridge.js');
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bukowski-chan-home-'));
const DIR_ALICE = path.join(FAKE_HOME, 'alice');
const DIR_BOB = path.join(FAKE_HOME, 'bob');
const DIR_CAROL = path.join(FAKE_HOME, 'carol');
const DIR_DAVE = path.join(FAKE_HOME, 'dave');
fs.mkdirSync(DIR_ALICE, { recursive: true });
fs.mkdirSync(DIR_BOB, { recursive: true });
fs.mkdirSync(DIR_CAROL, { recursive: true });
fs.mkdirSync(DIR_DAVE, { recursive: true });

const SENTINEL = 'please review PR #42 on branch foo';
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

// Strip any inherited BUKOWSKI_* vars so a bukowski we're *running inside of*
// (this very session) doesn't leak its BUKOWSKI_AGENT_ID / socket into the
// children — that would make the spawned bridges mis-register as our agent
// instead of fresh external agents. Then layer on only what each child needs.
function cleanEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('BUKOWSKI_')) env[k] = v;
  }
  return { ...env, HOME: FAKE_HOME, ...extra };
}

// A bridge client: spawn the real bridge, write JSON-RPC lines to stdin, and
// collect parsed messages (responses + forwarded notifications) from stdout.
function makeBridge(cwd, agentType = 'claude', extraEnv = {}, extraArgs = []) {
  const child = spawn('node', [BRIDGE, ...extraArgs], {
    cwd,
    env: cleanEnv({ BUKOWSKI_MCP_SOCKET: socketPath, BUKOWSKI_AGENT_TYPE: agentType, ...extraEnv }),
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  procs.push(child);
  const client = { child, messages: [], buf: '' };
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

// Wait until `pred(client.messages)` returns truthy, or time out.
async function waitFor(client, pred, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = pred(client.messages);
    if (hit) return hit;
    await sleep(50);
  }
  fail(`timed out waiting for ${what}`, 'messages: ' + JSON.stringify(client.messages, null, 2));
}

let socketPath = null;

// Call bukowski/peek_messages over a raw socket, exactly as the Stop /
// UserPromptSubmit hooks do, and return the pending count for an agent.
function peekCount(agentId) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    const timer = setTimeout(() => { try { sock.destroy(); } catch {} reject(new Error('peek timeout')); }, 3000);
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    sock.once('connect', () => {
      sock.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { agentId } }) + '\n');
      sock.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'bukowski/peek_messages', params: { agentId } }) + '\n');
    });
    sock.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2) {
          clearTimeout(timer);
          try { sock.end(); } catch {}
          resolve(msg.result?.count ?? -1);
        }
      }
    });
  });
}

// Spawn bukowski in a PTY and wait for the MCP socket discovery file.
const buko = pty.spawn('node', [path.join(REPO, 'multi.js')], {
  name: 'xterm-256color', cols: 120, rows: 30, cwd: REPO,
  env: cleanEnv({ BUKOWSKI_HOST: 'chtest' }),
});
procs.push(buko);
let bukoBuf = '';
buko.on('data', (d) => { bukoBuf += d.toString(); });

(async () => {
  // 1. Wait for the legacy discovery file to point at a live socket.
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

  // 2. Connect bridges and run the MCP init handshake. alice + bob are claude
  //    agents; carol is a codex agent (to prove codex gets NO channel push).
  const alice = makeBridge(DIR_ALICE, 'claude');
  const bob = makeBridge(DIR_BOB, 'claude');
  const carol = makeBridge(DIR_CAROL, 'codex');
  for (const c of [alice, bob, carol]) {
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }
  // Each must answer initialize (bridge's own canned response).
  await waitFor(alice, (m) => m.find((x) => x.id === 1 && x.result), 4000, 'alice initialize');
  await waitFor(bob, (m) => m.find((x) => x.id === 1 && x.result), 4000, 'bob initialize');
  await waitFor(carol, (m) => m.find((x) => x.id === 1 && x.result), 4000, 'carol initialize');

  // 3. Poll list_agents (via alice) until both external agents are registered.
  //    The bridge connects to bukowski asynchronously, so retry.
  let ids = null;
  const regDeadline = Date.now() + 6000;
  while (Date.now() < regDeadline) {
    alice.send({ jsonrpc: '2.0', id: 100, method: 'tools/call',
      params: { name: 'list_agents', arguments: {} } });
    const resp = await waitFor(alice, (m) => m.find((x) => x.id === 100), 2000, 'list_agents response');
    // Consume this response id so the next poll's waitFor sees a fresh one.
    alice.messages = alice.messages.filter((x) => x.id !== 100);
    try {
      const text = resp.result?.content?.[0]?.text || '[]';
      const agents = JSON.parse(text);
      const ext = agents.filter((a) => a.source === 'external').map((a) => a.id);
      if (ext.includes('claude-alice-1') && ext.includes('claude-bob-1') &&
          ext.includes('codex-carol-1')) {
        ids = ext; break;
      }
    } catch { /* not ready */ }
    await sleep(250);
  }
  if (!ids) fail('bridge agents never registered (claude-alice-1 / claude-bob-1 / codex-carol-1)');
  console.log(`registered: ${ids.join(', ')}`);

  // 4. alice -> bob fipa_request, then scan bob's stdout for the channel ping.
  const before = bob.messages.length;
  alice.send({ jsonrpc: '2.0', id: 200, method: 'tools/call', params: {
    name: 'fipa_request',
    arguments: { to: 'claude-bob-1', action: SENTINEL },
  } });
  await waitFor(alice, (m) => m.find((x) => x.id === 200), 3000, 'fipa_request response');

  const ping = await waitFor(
    bob,
    (m) => m.slice(before).find((x) => x.method === 'notifications/claude/channel'),
    3000,
    'channel ping on bob',
  );

  // 5. Assert the ping is well-formed.
  if ('id' in ping) fail('channel ping has an `id` — notifications must omit it', JSON.stringify(ping));
  const { content, meta } = ping.params || {};
  if (!content || !content.includes(SENTINEL)) {
    fail('channel ping content missing the sentinel', JSON.stringify(ping.params, null, 2));
  }
  if (!meta || meta.sender !== 'claude-alice-1' || meta.performative !== 'request') {
    fail('channel ping meta wrong', JSON.stringify(meta));
  }
  if (!meta.inbox_id) fail('channel ping meta missing inbox_id (needed to dedup vs the inbox)', JSON.stringify(meta));

  console.log('channel ping received by bob:');
  console.log('  method:', ping.method);
  console.log('  meta:  ', JSON.stringify(meta));
  console.log('  content:', JSON.stringify(content.split('\n')[0] + ' …'));

  // 6. Codex must NOT get a channel push — channels are Claude-only. Send carol
  //    a fipa_request and confirm no notifications/claude/channel arrives.
  const carolBefore = carol.messages.length;
  alice.send({ jsonrpc: '2.0', id: 300, method: 'tools/call', params: {
    name: 'fipa_request',
    arguments: { to: 'codex-carol-1', action: SENTINEL },
  } });
  await waitFor(alice, (m) => m.find((x) => x.id === 300), 3000, 'fipa_request to carol response');
  await sleep(1500); // give any (erroneous) ping time to show up
  const leaked = carol.messages.slice(carolBefore)
    .find((x) => x.method === 'notifications/claude/channel');
  if (leaked) fail('codex agent received a channel ping (should be claude-only)', JSON.stringify(leaked));
  console.log('codex (carol) correctly received no channel ping');

  // 7. Dedup: a message injected via the channel push must be hidden from
  //    peek_messages so the Stop/UserPromptSubmit hooks don't re-surface and
  //    double-deliver it. bob got a channel push (→ hidden); carol (codex, no
  //    channel) stays pending so the hook safety net still delivers for it.
  const bobPending = await peekCount('claude-bob-1');
  const carolPending = await peekCount('codex-carol-1');
  if (bobPending !== 0) {
    fail(`bob's channel-delivered message should be hidden from peek (count=${bobPending}, expected 0); else the Stop hook double-delivers`);
  }
  if (carolPending !== 1) {
    fail(`codex carol's message should still be pending for the hook safety net (count=${carolPending}, expected 1)`);
  }
  console.log(`peek: bob=${bobPending} (channel-delivered → hook won't double), carol=${carolPending} (no channel → safety net intact)`);

  // 8. Dual-connection delivery: a claude agent with TWO connections — a bare
  //    tools bridge and a separate role:channel bridge (the plugin server) — must
  //    get the push on the channel connection (the production shape: tools from
  //    mcpServers.bukowski, channel from the plugin). We BROADCAST to all of an
  //    agent's connections, so the channel connection is guaranteed to receive
  //    it rather than depending on a brittle single-socket lookup.
  const daveTools = makeBridge(DIR_DAVE, 'claude'); // registers claude-dave-1 (external)
  daveTools.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await waitFor(daveTools, (m) => m.find((x) => x.id === 1 && x.result), 4000, 'dave-tools initialize');
  // Wait for claude-dave-1 to be registered before attaching the channel conn.
  const daveDeadline = Date.now() + 6000;
  while (Date.now() < daveDeadline) {
    daveTools.send({ jsonrpc: '2.0', id: 101, method: 'tools/call', params: { name: 'list_agents', arguments: {} } });
    const resp = await waitFor(daveTools, (m) => m.find((x) => x.id === 101), 2000, 'dave list_agents');
    daveTools.messages = daveTools.messages.filter((x) => x.id !== 101);
    try {
      const agents = JSON.parse(resp.result?.content?.[0]?.text || '[]');
      if (agents.some((a) => a.id === 'claude-dave-1')) break;
    } catch { /* not ready */ }
    await sleep(250);
  }
  // Channel-only connection for the same agent id. Signal the role via the
  // --role=channel ARG (NOT the env var) — that's how the bukowski-channel
  // plugin does it in production, because Claude Code's channel loader forwards
  // a plugin's args but drops its declared env. Asserting the arg path here
  // guards against the regression where an env-only role left the channel
  // server running in tools mode and Claude cycled it.
  const daveChannel = makeBridge(DIR_DAVE, 'claude', { BUKOWSKI_AGENT_ID: 'claude-dave-1' }, ['--role=channel']);
  daveChannel.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await waitFor(daveChannel, (m) => m.find((x) => x.id === 1 && x.result), 4000, 'dave-channel initialize');
  await sleep(500); // let the role:channel registration land on the server

  const toolsBefore = daveTools.messages.length;
  const chanBefore = daveChannel.messages.length;
  alice.send({ jsonrpc: '2.0', id: 400, method: 'tools/call', params: {
    name: 'fipa_request', arguments: { to: 'claude-dave-1', action: SENTINEL },
  } });
  await waitFor(alice, (m) => m.find((x) => x.id === 400), 3000, 'fipa_request to dave response');
  await waitFor(daveChannel, (m) => m.slice(chanBefore).find((x) => x.method === 'notifications/claude/channel'),
    3000, 'channel ping on dave-channel connection');
  void toolsBefore; // tools-conn may also receive it (broadcast) — that's fine, it's ignored client-side
  console.log('delivery: dave channel-conn received the ping (broadcast reaches every connection)');
  console.log('OK: channel-push smoke passed');

  // Tear down.
  buko.kill('SIGINT');
  await sleep(500);
  cleanup();
  process.exit(0);
})().catch((e) => fail('unexpected error: ' + (e.stack || e.message)));
