#!/usr/bin/env node
// Regression: every id that routes must be discoverable from list_agents.
//
//   bug-17  A session agent is addressable twice — locally (codex-1) and by
//           its federated alias (codex-projects-1, canonicalized by
//           resolveLocalAlias inside _sendFipaMessage). list_agents listed
//           only the local id and tucked the alias into a `federatedId`
//           field, so an agent scanning ids for the name a peer had given it
//           found nothing and concluded the target was gone — while sending
//           to that very name worked. Reported by claude-projects-2 as
//           "sends to a non-visible target silently succeed"; the send was
//           always routable, the roster just never said so.
//
// The invariant: anything list_agents omits must be refused by the send path,
// and anything the send path accepts must be reachable from the roster.
//
// Pure/fast: real MCPServer dispatch + real FederationHub, no sockets.

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { MCPServer } = require(path.join(ROOT, 'src', 'mcp', 'MCPServer'));
const { FederationHub } = require(path.join(ROOT, 'src', 'federation', 'FederationHub'));

let failed = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${msg}`);
  if (!cond) failed++;
};

function setup() {
  const pane = { id: 'codex-1', name: 'codex', type: 'codex', pty: { pid: 4242 } };
  const room = { id: 'chat-abc', name: 'room', type: 'chat' };
  const session = {
    id: 's1',
    getAgent: (id) => [pane, room].find((a) => a.id === id) || null,
    getAllAgents: () => [pane, room],
  };
  const s = Object.create(MCPServer.prototype);
  s.session = session;
  s.externalAgents = new Map();
  s.agentCounters = new Map();
  s.agentAliases = new Map();
  s.messageQueues = new Map();
  s.sent = [];
  const rec = () => (from, to) => s.sent.push({ to });
  s.fipaHub = { inform: rec(), request: rec(), agree: rec(), refuse: rec(),
    propose: rec(), queryIf: rec(), queryRef: rec() };

  const fed = new FederationHub({ host: 'projects', sessionId: 's1' });
  // Mirrors multi.js snapshotLocalRoster: pty agents get a host-named alias,
  // bridge clients and chat rooms federate under their own id.
  fed.getLocalRoster = () => [
    ...session.getAllAgents().filter((a) => a.type !== 'chat')
      .map((a) => ({ localId: a.id, type: a.type, federatedId: `${a.type}-projects-1` })),
    ...s.getExternalAgents().map((a) => ({ localId: a.id, type: a.type, federatedId: a.id })),
    ...session.getAllAgents().filter((a) => a.type === 'chat')
      .map((a) => ({ localId: a.id, type: 'chat', federatedId: a.id })),
  ];
  s.federationHub = fed;
  return { s, fed };
}

(async () => {
  const { s, fed } = setup();
  s._assignAgentId('codex', { once: () => {} }, '/home/x/projects/azra-agent');
  fed.peers.set('vlad', { host: 'vlad', socket: {} });
  fed._ingestPeerRoster('vlad', [{ federatedId: 'claude-vlad-1', localId: 'claude-1', type: 'claude' }], 'vlad');

  const roster = await s._handleToolCall('list_agents', {}, 'claude-projects-2');
  const byId = new Map(roster.map((a) => [a.id, a]));

  // ── 1. A session agent advertises its federated alias ────────────────────
  ok(byId.get('codex-1').aliases.includes('codex-projects-1'),
    'a session agent lists its federated alias among its aliases');
  ok(byId.get('codex-1').federatedId === 'codex-projects-1',
    'and still carries federatedId for existing readers');

  // ── 2. No entry repeats its own id as an alias ───────────────────────────
  for (const a of roster) {
    ok(!a.aliases.includes(a.id), `${a.id} does not list itself as an alias`);
  }
  ok(byId.get('chat-abc').aliases.length === 0,
    'a chat room federates under its own id, so it has no second spelling');
  ok(byId.get('codex-azra-agent-1').aliases.length === 0,
    'a bridge client\'s id already embeds its host — no alias');
  ok(byId.get('claude-vlad-1').aliases.length === 0,
    'a federated peer is listed under the name callers use');

  // ── 3. Every advertised name routes, and routes to the right agent ───────
  const names = roster.flatMap((a) => [a.id, ...a.aliases]);
  ok(names.length === roster.length + 1, 'exactly one alias across the roster');
  for (const name of names) {
    s.sent.length = 0;
    let threw = null;
    try { await s._handleToolCall('fipa_inform', { to: name, content: 'x' }, 'claude-projects-2'); }
    catch (e) { threw = e; }
    ok(!threw, `${name} is accepted by the send path`);
  }
  s.sent.length = 0;
  await s._handleToolCall('fipa_inform', { to: 'codex-projects-1', content: 'x' }, 'claude-projects-2');
  ok(s.sent[0].to === 'codex-1', 'the alias is canonicalized to the local id on delivery');

  // ── 4. ...and a name nobody advertises is still refused ──────────────────
  let threw = null;
  try { await s._handleToolCall('fipa_inform', { to: 'codex-nowhere-9', content: 'x' }, 'claude-projects-2'); }
  catch (e) { threw = e; }
  ok(threw && /Unknown agent/.test(threw.message), 'an unadvertised id is refused, not silently accepted');

  if (failed > 0) {
    console.log(`${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log('list-agents-aliases OK');
})();
