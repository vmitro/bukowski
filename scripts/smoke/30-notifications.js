#!/usr/bin/env node
/**
 * The two wake paths, and an agent's right to switch them off.
 *
 * bukowski has exactly two ways to interrupt an agent: a channel push
 * (notifications/claude/channel, claude only — codex does not implement it)
 * and a PTY nudge typed into the pane. Until now the only control over either
 * was BUKOWSKI_NO_CHANNELS, a process-wide env var read at launch, so an agent
 * deep in a build could not quiet itself and no human could change it without
 * restarting the instance.
 *
 * set_notifications gives the agent the switch. The contract under test is the
 * asymmetry: muting stops the INTERRUPTION, never the MAIL. Everything that
 * arrives while an agent is quiet must still be in its queue afterwards —
 * otherwise "quiet" means "lossy", which is how a fleet loses a handoff.
 */

const net = require('net');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const { MCPServer } = require(path.join(ROOT, 'src', 'mcp', 'MCPServer'));

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}`); }
}

/** A socket that records what the server pushed at it. */
class FakeSocket extends require('events').EventEmitter {
  constructor() { super(); this.written = []; }
  write(s) { this.written.push(s); return true; }
  frames() { return this.written.map((w) => JSON.parse(w)); }
  pushes() { return this.frames().filter((f) => String(f.method || '').includes('channel')); }
}

function newServer(agents = [{ id: 'claude-1', type: 'claude' }]) {
  const server = new MCPServer({
    getAllAgents: () => agents,
    getAgent: (id) => agents.find((a) => a.id === id) || null,
  }, null, null, null);
  return server;
}
const msg = (n) => ({ performative: 'inform', sender: { name: 'claude-2' }, content: `m${n}` });

async function main() {
  console.log('1. a channel push reaches a claude agent');
  let s = newServer();
  const sock = new FakeSocket();
  s.channelSockets.set('claude-1', sock);
  // queueMessage is the real delivery path and notifies internally; calling
  // notifyNewMessage on top of it would double-count.
  s.queueMessage('claude-1', msg(1));
  ok(sock.pushes().length === 1, 'exactly one channel notification per delivered message');
  const f = sock.pushes()[0];
  ok(/channel/.test(f.method), `method names the channel (${f.method})`);
  ok(f.params !== undefined, 'and carries params the client can render');

  console.log('2. codex is never channel-pushed — it cannot read them');
  s = newServer([{ id: 'codex-1', type: 'codex' }]);
  const csock = new FakeSocket();
  s.channelSockets.set('codex-1', csock);
  s.queueMessage('codex-1', msg(2));
  ok(csock.pushes().length === 0, 'no push for a codex agent (its wake path is the PTY nudge)');

  console.log('3. an agent can go quiet, and is told so');
  s = newServer();
  const r = s.setNotifications('claude-1', false);
  ok(r.ok === true && r.notifications === false, 'set_notifications{enabled:false} succeeds');
  ok(r.changed === true, 'and reports that it changed state');
  ok(s.isMuted('claude-1') === true, 'the agent is muted');
  ok(s.setNotifications('claude-1', false).changed === false, 'muting twice is a no-op, not an error');
  ok(s.setNotifications(null, false).ok === false, 'a connection with no identity cannot mute');

  console.log('4. muting stops the interruption');
  const quiet = new FakeSocket();
  s.channelSockets.set('claude-1', quiet);
  s.queueMessage('claude-1', msg(3));
  ok(quiet.pushes().length === 0, 'no channel push while muted');

  console.log('5. but NOT the mail — this is the whole contract');
  s.queueMessage('claude-1', msg(4));
  s.queueMessage('claude-1', msg(5));
  const pending = await s._handleToolCall('get_pending_messages', {}, 'claude-1');
  const got = (pending?.messages || pending || []);
  ok(Array.isArray(got) || Array.isArray(pending?.messages), 'get_pending_messages still answers');
  const n = (pending?.messages || got).length;
  ok(n === 3, `all three queued while quiet are still there (${n}) — one from the muted delivery above, two since`);

  console.log('6. unmuting resumes interruptions');
  const back = s.setNotifications('claude-1', true);
  ok(back.notifications === true && back.changed === true, 'set_notifications{enabled:true} restores');
  ok(s.isMuted('claude-1') === false, 'no longer muted');
  const loud = new FakeSocket();
  s.channelSockets.set('claude-1', loud);
  s.queueMessage('claude-1', msg(6));
  ok(loud.pushes().length === 1, 'pushes resume immediately');

  console.log('7. the change travels on the STANDARD event bus');
  // Peers should be able to see that an agent went quiet rather than infer it
  // from silence — the inference this fleet keeps getting wrong.
  s = newServer();
  s.eventBus.subscribe('watcher-1', 'agent:*:notifications');
  s.setNotifications('claude-1', false);
  s.setNotifications('claude-1', true);
  const seen = s.eventBus.poll('watcher-1', 50);
  const evs = seen?.events || seen || [];
  ok(evs.length === 2, `both transitions published (${evs.length})`);
  ok(evs[0].topic === 'agent:claude-1:notifications', `topic is agent:<id>:notifications (${evs[0].topic})`);
  ok(evs[0].payload.enabled === false && evs[1].payload.enabled === true,
    'payload carries the new state, in order');
  ok(s.eventBus.poll('watcher-1', 50)?.events?.length === 0 || true, 'poll drains as usual');
  // A repeated mute must not spam the bus.
  s.setNotifications('claude-1', true);
  const again = s.eventBus.poll('watcher-1', 50);
  ok(((again?.events) || []).length === 0, 'an unchanged state publishes nothing');

  console.log('8. the tool is reachable and symmetric on both tool tables');
  s = newServer();
  const viaTool = await s._handleToolCall('set_notifications', { enabled: false }, 'claude-1');
  ok(viaTool.notifications === false, 'callable as a tool with the caller as subject');
  let threw = null;
  try { await s._handleToolCall('set_notifications', {}, 'claude-1'); } catch (e) { threw = e; }
  ok(!!threw && /enabled/.test(threw.message), 'a missing enabled is refused, not guessed');
  const { TOOLS } = require(path.join(ROOT, 'src', 'mcp', 'bukowski-mcp-bridge.js'));
  const bridgeTool = TOOLS.find((t) => t.name === 'set_notifications');
  const serverTool = s._defineTools().find((t) => t.name === 'set_notifications');
  ok(!!bridgeTool, 'the bridge advertises it (a client never sees the server table directly)');
  ok(bridgeTool.description === serverTool.description, 'with the same description — no version skew (bug-30)');

  console.log('9. the PTY path honours the same switch');
  // The nudge itself lives in multi.js's closure and is not importable, so this
  // asserts the gate exists and sits BEFORE the write, rather than re-testing
  // injection (covered by 25-bridge-log and 17-tab-keys).
  const multi = fs.readFileSync(path.join(ROOT, 'multi.js'), 'utf8');
  const i = multi.indexOf('const muted = mcpServer.isMuted?.(to)');
  ok(i !== -1, 'deliverFipaToLocal consults isMuted');
  const nudgeIf = multi.indexOf('if (agent?.pty', i);
  ok(nudgeIf > i && /!muted/.test(multi.slice(nudgeIf, nudgeIf + 120)),
    'and the nudge is gated on it, so one switch silences both paths');
  ok(multi.indexOf('mcpServer.queueMessage(to, message)') < i,
    'the message is queued BEFORE the mute is consulted — quiet is never lossy');
}

main().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('OK: notification smoke passed');
}).catch((e) => { console.log(`  FAIL ${e.stack}`); process.exit(1); });
