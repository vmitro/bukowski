#!/usr/bin/env node
/**
 * A federated roster entry must say WHAT it is (bug-29).
 *
 * Locally the distinction is visible: a pty agent is source 'session' and
 * carries its federated spelling in `aliases`, a bridge client is 'external'.
 * None of that crossed the wire — the record was {localId, type, federatedId}
 * and the receiving side rendered every entry identically with `aliases: []`.
 * So from another host, codex-projects-1 (a PANE alias), codex-projects-4 (a
 * SEAT) and a chat room looked alike, and a sender could not tell which name
 * reaches a readable queue, which only nudges a screen, and which is a room.
 *
 * Observed 2026-10-27: claude-managed-1 read two such entries off its roster,
 * concluded "distinct agents with a pane-label collision" (they were one
 * agent), and sent a task proposal to a pane alias where, for codex, the
 * content is unrecoverable. It had no way to see that before sending.
 *
 * `kind` is the field it needed. It is additive: an older peer omits it and
 * the receiver must render null rather than guessing.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { FederationHub } = require(path.join(ROOT, 'src', 'federation', 'FederationHub'));
const { MCPServer } = require(path.join(ROOT, 'src', 'mcp', 'MCPServer'));

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}`); }
}

/** A hub whose local roster is whatever we hand it. */
function hubWith(roster) {
  return new FederationHub({
    host: 'testbox',
    machineHost: 'testbox',
    sessionId: 's1',
    peerRegistry: { getPeers: () => [], on() {}, off() {} },
    getLocalRoster: () => roster,
  });
}

console.log('1. the local snapshot carries kind outward');
const hub = hubWith([
  { localId: 'codex-1', type: 'codex', federatedId: 'codex-projects-1', kind: 'pane' },
  { localId: 'codex-projects-4', type: 'codex', federatedId: 'codex-projects-4', kind: 'seat' },
  { localId: 'chat-abc', type: 'chat', federatedId: 'chat-abc', kind: 'room' },
]);
const snap = hub._localRosterSnapshot();
ok(snap.length === 3, 'all three records survive the snapshot');
ok(snap.find((a) => a.federatedId === 'codex-projects-1').kind === 'pane', 'a pty agent is a pane');
ok(snap.find((a) => a.federatedId === 'codex-projects-4').kind === 'seat', 'a bridge client is a seat');
ok(snap.find((a) => a.federatedId === 'chat-abc').kind === 'room', 'a chat room is a room');

console.log('2. a record without kind is null, never guessed');
// An older peer simply does not send the field. Inferring "pane" from the
// absence would be exactly the reasoning this entry exists to stop.
const oldHub = hubWith([{ localId: 'claude-1', type: 'claude', federatedId: 'claude-old-1' }]);
ok(oldHub._localRosterSnapshot()[0].kind === null, 'missing kind snapshots as null');

console.log('3. kind survives ingest from a peer');
const rx = hubWith([]);
rx._ingestPeerRoster('peerbox', [
  { localId: 'codex-2', type: 'codex', federatedId: 'codex-peer-2', kind: 'pane' },
  { localId: 'codex-peer-9', type: 'codex', federatedId: 'codex-peer-9', kind: 'seat' },
  { localId: 'claude-3', type: 'claude', federatedId: 'claude-peer-3' },
], 'peerbox');
ok(rx.resolveRemote('codex-peer-2')?.kind === 'pane', 'an ingested pane keeps its kind');
ok(rx.resolveRemote('codex-peer-9')?.kind === 'seat', 'an ingested seat keeps its kind');
ok(rx.resolveRemote('claude-peer-3')?.kind === null, 'an old peer entry is null, not inferred');
ok(rx.resolveRemote('codex-peer-2')?.localTargetId === 'codex-2',
  'and the local id it answers to on its own box is retained');

console.log('4. a shorter path wins and brings its kind; an equal one does not churn');
// _recordRemote adopts only a STRICTLY shorter path, so the mesh converges
// instead of re-flooding. kind must ride along on the entry that wins.
rx._recordRemote('codex-far-1', {
  peerHost: 'hub', machineHost: 'hub', via: 'hub', path: ['hub', 'far'],
  localTargetId: 'codex-1', type: 'codex', kind: 'pane',
});
ok(rx.resolveRemote('codex-far-1').via === 'hub', 'the two-hop route is recorded first');
rx._recordRemote('codex-far-1', {
  peerHost: 'far', machineHost: 'far', via: 'far', path: ['far'],
  localTargetId: 'codex-1', type: 'codex', kind: 'seat',
});
ok(rx.resolveRemote('codex-far-1').via === 'far', 'a one-hop route replaces it');
ok(rx.resolveRemote('codex-far-1').kind === 'seat', 'and its kind replaces the old one too');
// Equal length must be refused, or two peers advertising the same agent flap.
rx._recordRemote('codex-far-1', {
  peerHost: 'other', machineHost: 'other', via: 'other', path: ['other'],
  localTargetId: 'codex-1', type: 'codex', kind: 'pane',
});
ok(rx.resolveRemote('codex-far-1').via === 'far', 'an equal-length route is refused (no flapping)');
ok(rx.resolveRemote('codex-far-1').kind === 'seat', 'so the kind it holds is unchanged');

console.log('5. list_agents renders it, so a sender can see it BEFORE sending');
const server = new MCPServer({ getAllAgents: () => [], getAgent: () => null }, null, null, null);
server.federationHub = {
  remoteAgents: new Map([
    ['codex-peer-2', { peerHost: 'peerbox', machineHost: 'peerbox', via: 'peerbox', type: 'codex', localTargetId: 'codex-2', kind: 'pane' }],
    ['codex-peer-9', { peerHost: 'peerbox', machineHost: 'peerbox', via: 'peerbox', type: 'codex', localTargetId: 'codex-peer-9', kind: 'seat' }],
    ['chat-xyz', { peerHost: 'peerbox', machineHost: 'peerbox', via: 'peerbox', type: 'chat', localTargetId: 'chat-xyz', kind: 'room' }],
    ['claude-old-1', { peerHost: 'oldbox', machineHost: 'oldbox', via: 'oldbox', type: 'claude', localTargetId: 'claude-1' }],
  ]),
  federatedIdFor: () => null,
  resolveLocalAlias: () => null,
};

async function main() {
  const listed = await server._handleToolCall('list_agents', {}, 'claude-1');
  const by = (id) => listed.find((a) => a.id === id);
  ok(by('codex-peer-2').kind === 'pane', 'a pane is labelled pane');
  ok(by('codex-peer-9').kind === 'seat', 'a seat is labelled seat');
  ok(by('chat-xyz').kind === 'room', 'a room is labelled room');
  ok(by('claude-old-1').kind === null, 'an entry from a pre-kind box is null');
  ok(by('codex-peer-2').paneId === 'codex-2',
    'a pane exposes the local id it answers to, which is what its status bar shows');
  ok(by('codex-peer-9').paneId === null, 'a seat has no paneId — it is not a pane');
  ok(by('claude-old-1').paneId === null, 'nor does an unknown-kind entry claim one');

  console.log('6. the tool description tells callers what the kinds mean');
  const { TOOLS } = require(path.join(ROOT, 'src', 'mcp', 'bukowski-mcp-bridge.js'));
  const bridgeDesc = TOOLS.find((t) => t.name === 'list_agents').description;
  const serverDesc = server._defineTools().find((t) => t.name === 'list_agents').description;
  ok(bridgeDesc === serverDesc, 'both tool tables agree (no bug-30 skew)');
  for (const word of ['kind', 'pane', 'seat', 'room', 'null']) {
    ok(bridgeDesc.includes(word), `the description explains "${word}"`);
  }
}

main().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('OK: federated kind smoke passed');
}).catch((e) => { console.log(`  FAIL ${e.stack}`); process.exit(1); });
