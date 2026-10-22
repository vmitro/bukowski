#!/usr/bin/env node
// Regression: a bridge connection that runs inside a pane must be recognised
// AS that pane's agent, not handed a second identity.
//
//   bug-16  Identity priority is agentId > ancestor-pid match > cwd naming.
//           The ancestor list was computed by the CLIENT and missed in three
//           ways: it started above its own pid (so a bridge that exec'd into
//           the pane never matched), it abandoned every ancestor above the
//           first unreadable /proc entry, and it capped at depth 10 — thinner
//           than a real pane's tmux -> shell -> wrapper -> REPL -> bridge
//           nesting. Every miss fell through to cwd naming, so one process
//           answered to a pane id while stamping its sends with a cwd-derived
//           one, and the queue it was sent on was drained by nobody.
//
// The walk now happens server-side from /proc, with session-id and controlling
// -terminal fallbacks for the reparented case. Linux-only; absent /proc must
// read as "no evidence", never as a match.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const { parseStat, ancestorsOf, resolvePaneAgent } = require(path.join(ROOT, 'src', 'utils', 'procTree'));

let failed = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${msg}`);
  if (!cond) failed++;
};

if (!fs.existsSync('/proc/self/stat')) {
  console.log('SKIP: no /proc on this platform');
  process.exit(0);
}

// ── 1. parseStat survives a comm field with spaces and parentheses ─────────
{
  const self = parseStat(process.pid);
  ok(self && self.pid === process.pid, 'parseStat reads our own entry');
  ok(self.ppid === process.ppid, 'ppid matches process.ppid');
  ok(Number.isFinite(self.sid) && Number.isFinite(self.tty), 'sid and tty parse as numbers');
  ok(parseStat(0x7ffffff) === null, 'a pid that does not exist reads as null, not a throw');
  ok(parseStat('nonsense') === null, 'a nonsense pid reads as null');

  // A process named "(a b) c" would break a naive whitespace split.
  const sh = spawn('/bin/sh', ['-c', 'exec -a "(a b) c" sleep 5']);
  try {
    execFileSync('/bin/sh', ['-c', 'sleep 0.3']);
    const st = parseStat(sh.pid);
    ok(st !== null, 'a comm containing spaces and parens still parses');
    ok(st && st.ppid === process.pid, 'and reports the right parent');
  } finally { try { sh.kill('SIGKILL'); } catch {} }
}

// ── 2. ancestorsOf includes the pid itself and climbs past depth 10 ────────
{
  const chain = ancestorsOf(process.pid);
  ok(chain[0] === process.pid, 'the walk includes the starting pid — an exec\'d bridge IS the pane');
  ok(chain.includes(process.ppid), 'and its parent');
  ok(new Set(chain).size === chain.length, 'no pid repeats');
  ok(!chain.includes(1) && !chain.includes(0), 'the walk stops below init');
  ok(ancestorsOf(process.pid, 2).length === 2, 'maxDepth is honoured');
  ok(ancestorsOf(0x7ffffff).length === 1,
    'an unreadable start still reports the pid asked about, rather than throwing');
  ok(ancestorsOf(1).length === 0, 'init itself yields nothing to climb');
}

// ── 3. A connection inside a pane resolves to that pane's agent ────────────
{
  const chain = ancestorsOf(process.pid);
  const grandparent = chain[2] ?? chain[chain.length - 1];
  const agents = [
    { id: 'claude-1', type: 'claude', pty: { pid: grandparent } },
    { id: 'codex-1', type: 'codex', pty: { pid: 999999999 } },
    { id: 'chat-x', type: 'chat' }, // no pty at all
  ];
  const hit = resolvePaneAgent(agents, { pid: process.pid });
  ok(hit && hit.agent.id === 'claude-1', 'an ancestor pty pid identifies the pane');
  ok(hit && hit.via === 'lineage', 'and reports lineage as the evidence');

  // The exec'd case: the pty pid IS the client's pid.
  const self = resolvePaneAgent([{ id: 'claude-1', pty: { pid: process.pid } }], { pid: process.pid });
  ok(self && self.via === 'lineage', 'a bridge whose own pid is the pty pid matches');

  ok(resolvePaneAgent([], { pid: process.pid }) === null, 'no agents means no match');
  ok(resolvePaneAgent([{ id: 'chat-x', type: 'chat' }], { pid: process.pid }) === null,
    'an agent with no pty is never matched');
}

// ── 4. Nothing conclusive must stay inconclusive ──────────────────────────
{
  const unrelated = [{ id: 'claude-1', pty: { pid: 999999998 } }];
  ok(resolvePaneAgent(unrelated, { pid: process.pid }) === null,
    'an unrelated pane is not matched — the caller must mint a separate id');
  ok(resolvePaneAgent(unrelated, {}) === null, 'no pid and no claim is not a match');
  ok(resolvePaneAgent(unrelated, { pid: 0x7ffffff }) === null,
    'a pid with no /proc entry is no evidence, not a match');
}

// ── 5. The legacy self-reported list is still honoured ────────────────────
{
  const agents = [{ id: 'claude-1', pty: { pid: 424242 } }];
  const hit = resolvePaneAgent(agents, { claimedPids: [424242] });
  ok(hit && hit.agent.id === 'claude-1', 'a pre-`pid` bridge still matches on its claimed ancestors');
  ok(resolvePaneAgent(agents, { claimedPids: ['424242'] })?.agent.id === 'claude-1',
    'string pids from JSON are coerced');
}

// ── 6. A same-session sibling must NOT be absorbed into a pane ────────────
{
  // Everything launched from one shell shares a session and a controlling
  // terminal, so neither is evidence of containment. Matching on them would
  // pull an unrelated REPL into a pane — two processes answering as one agent,
  // which is worse than the bug being fixed. (It also broke 07-dashboard,
  // whose bridges are siblings of a pty'd bukowski.)
  const sibling = spawn('/bin/sh', ['-c', 'sleep 5']);
  try {
    execFileSync('/bin/sh', ['-c', 'sleep 0.3']);
    const self = parseStat(process.pid);
    const sibStat = parseStat(sibling.pid);
    ok(sibStat !== null, 'the sibling has a /proc entry');
    ok(!ancestorsOf(process.pid).includes(sibling.pid), 'and is NOT on our lineage');
    ok(sibStat && self && sibStat.sid === self.sid, 'but DOES share our session');

    const agents = [{ id: 'claude-1', pty: { pid: sibling.pid } }];
    ok(resolvePaneAgent(agents, { pid: process.pid }) === null,
      'a pane whose pty merely shares our session is not matched');

    // Containment still wins where it exists.
    const both = [
      { id: 'sibling-pane', pty: { pid: sibling.pid } },
      { id: 'real-pane', pty: { pid: process.ppid } },
    ];
    ok(resolvePaneAgent(both, { pid: process.pid })?.agent.id === 'real-pane',
      'the contained pane is the one matched');
  } finally { try { sibling.kill('SIGKILL'); } catch {} }
}

// ── 7. The evidence is always named ───────────────────────────────────────
{
  ok(resolvePaneAgent([{ id: 'a', pty: { pid: process.ppid } }], { pid: process.pid }).via === 'lineage',
    'a server-derived match is reported as lineage');
  ok(resolvePaneAgent([{ id: 'a', pty: { pid: 424242 } }], { claimedPids: [424242] }).via === 'claimed',
    'a match that rests only on the client\'s word is reported as claimed');
}

(async () => {
  // ── 8. End to end: initialize assigns the PANE id, not a second one ───────
  {
    const { MCPServer } = require(path.join(ROOT, 'src', 'mcp', 'MCPServer'));

    const makeServer = (pane) => {
      const s = Object.create(MCPServer.prototype);
      s.session = { getAllAgents: () => [pane], getAgent: (id) => (id === pane.id ? pane : null) };
      s.externalAgents = new Map();
      s.agentCounters = new Map();
      s.externalAgentKeys = new Map();
      s.channelSockets = new Map();
      s.emit = () => {};
      s._getToolsForAgent = () => [];
      return s;
    };
    const initialize = async (srv, params) => {
      const replies = [];
      const socket = { once: () => {}, write: () => {} };
      srv._sendResult = (_sock, _id, result) => replies.push(result);
      const clientState = {};
      await srv._handleRequest(socket, clientState, { id: 1, method: 'initialize', params });
      return { assigned: clientState.agentId, reply: replies[0] };
    };

    // The reported shape: a codex pane whose bridge runs with a cwd belonging to
    // another project. Before the fix the ancestor match missed and this minted
    // codex-azra-agent-1 alongside the pane's own codex-1.
    const pane = { id: 'codex-1', name: 'codex', type: 'codex', pty: { pid: process.ppid } };
    const srv = makeServer(pane);
    const r = await initialize(srv, {
      agentType: 'codex',
      agentId: null,
      pid: process.pid,
      cwd: '/home/sheemeh/projects/azra-agent',
    });
    ok(r.assigned === 'codex-1', 'a bridge inside the pane is assigned the PANE id');
    ok(r.reply.assignedAgentId === 'codex-1', 'and is told so in the initialize reply');
    ok(srv.externalAgents.size === 0, 'no second, cwd-derived identity is minted');

    // An unrelated REPL must still get its own external id.
    const srv2 = makeServer({ id: 'codex-1', type: 'codex', pty: { pid: 999999996 } });
    const r2 = await initialize(srv2, {
      agentType: 'codex', agentId: null, pid: process.pid,
      cwd: '/home/sheemeh/projects/azra-agent',
    });
    ok(r2.assigned === 'codex-azra-agent-1', 'an unrelated bridge still gets a cwd-named id');
    ok(srv2.externalAgents.has('codex-azra-agent-1'), 'and is tracked as external');

    // An explicit BUKOWSKI_AGENT_ID still outranks everything.
    const srv3 = makeServer(pane);
    const r3 = await initialize(srv3, {
      agentType: 'codex', agentId: 'codex-7', pid: process.pid, cwd: '/tmp',
    });
    ok(r3.assigned === 'codex-7', 'an explicit agentId still wins');
  }

  if (failed > 0) {
    console.log(`${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log('pane-identity OK');
})();
