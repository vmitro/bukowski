#!/usr/bin/env node
// Regression: a self-chosen name must be routable from ANOTHER instance.
//
//   bug-31  Agents are told to prefer the name they claim with register_agent,
//           because a seat id churns on every restart and a claimed name does
//           not. That guidance held only inside one instance. Three defects
//           stacked: the roster payload had no `aliases` field at all, so a
//           claim never crossed the wire; list_agents hardcoded `aliases: []`
//           on every federated row, so it could not have shown one anyway; and
//           the send path resolved claimed names against the LOCAL claim map
//           only, so addressing a remote claim failed "Unknown agent".
//           Reported by claude-azra-agent-1: two seats confirmed routableAs
//           [r00t-caus3] / [stream-r4c3r], and both were unaddressable from a
//           third instance on the same box.
//
// The invariant: a name an agent claims is reachable from every box that can
// see that agent at all, and list_agents says so before anyone sends.
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

const hubWith = (roster) => new FederationHub({
  host: 'box', machineHost: 'box', sessionId: 's1',
  peerRegistry: { getPeers: () => [], on() {}, off() {} },
  getLocalRoster: () => roster,
});

console.log('1. claimed names leave on the wire');
const hub = hubWith([
  { localId: 'codex-1', type: 'codex', federatedId: 'codex-box-1', kind: 'pane', aliases: ['r00t-caus3'] },
  { localId: 'codex-box-4', type: 'codex', federatedId: 'codex-box-4', kind: 'seat', aliases: ['stream-r4c3r', 'dj'] },
  { localId: 'claude-2', type: 'claude', federatedId: 'claude-box-2', kind: 'pane' },
]);
const snap = hub._localRosterSnapshot();
const sp = (fid) => snap.find((a) => a.federatedId === fid);
ok(sp('codex-box-1').aliases?.[0] === 'r00t-caus3', 'a pane carries its claimed name');
ok(sp('codex-box-4').aliases?.length === 2, 'a seat carries every claimed name');
ok(Array.isArray(sp('claude-box-2').aliases) && sp('claude-box-2').aliases.length === 0,
  'an agent that claimed nothing sends an empty list, not undefined');

console.log('2. they survive ingest on the far side');
const rx = hubWith([]);
rx._ingestPeerRoster('peerbox', snap, 'peerbox');
ok(rx.resolveRemote('codex-box-1')?.aliases?.[0] === 'r00t-caus3', 'the claim is recorded against the route');
ok(rx.resolveRemoteAlias?.('r00t-caus3') === 'codex-box-1', 'and resolves back to a federatedId');
ok(rx.resolveRemoteAlias?.('STREAM-R4C3R') === 'codex-box-4', 'case-insensitively, like the local claim map');
ok(rx.resolveRemoteAlias?.('dj') === 'codex-box-4', 'a second claimed name resolves to the same seat');
ok((rx.resolveRemoteAlias?.('nobody') ?? null) === null, 'an unclaimed name resolves to nothing');
// A peer predating the field must not look like it claimed something.
rx._ingestPeerRoster('oldbox', [{ localId: 'claude-1', type: 'claude', federatedId: 'claude-old-1' }], 'oldbox');
ok((rx.resolveRemote('claude-old-1')?.aliases?.length ?? -1) === 0, 'a pre-aliases peer yields an empty list');

console.log('3. a claim made AFTER the first record still lands');
// This is the half that made the feature dead on arrival: a claim arrives by
// the same route as the record it revises, and equal-length restatements were
// refused outright, so the name could never appear.
const late = hubWith([]);
late._ingestPeerRoster('peerbox', [
  { localId: 'codex-9', type: 'codex', federatedId: 'codex-peer-9', kind: 'seat', aliases: [] },
], 'peerbox');
ok((late.resolveRemoteAlias?.('late-name') ?? null) === null, 'before the claim, nothing resolves');
late._ingestPeerRoster('peerbox', [
  { localId: 'codex-9', type: 'codex', federatedId: 'codex-peer-9', kind: 'seat', aliases: ['late-name'] },
], 'peerbox');
ok(late.resolveRemoteAlias?.('late-name') === 'codex-peer-9', 'a same-route restatement revises the facts');

console.log('4. but a competing equal-length route still cannot displace (no flapping)');
late._recordRemote('codex-peer-9', {
  peerHost: 'rival', machineHost: 'rival', via: 'rival', path: ['rival'],
  localTargetId: 'codex-9', type: 'codex', kind: 'seat', aliases: ['hijack'],
});
ok(late.resolveRemote('codex-peer-9').via === 'peerbox', 'the incumbent route is kept');
ok((late.resolveRemoteAlias?.('hijack') ?? null) === null, 'and a rival cannot inject a name');
// An identical restatement must stay a no-op, or the mesh re-floods.
ok(late._recordRemote('codex-peer-9', {
  peerHost: 'peerbox', machineHost: 'peerbox', via: 'peerbox', path: ['peerbox'],
  localTargetId: 'codex-9', type: 'codex', kind: 'seat', aliases: ['late-name'],
}) === false, 'an unchanged same-route restatement is refused, so nothing re-floods');

console.log('5. list_agents shows them, so a sender sees the name before sending');
const server = new MCPServer({ getAllAgents: () => [], getAgent: () => null }, null, null, null);
server.federationHub = {
  remoteAgents: new Map([
    ['codex-box-4', { peerHost: 'peerbox', machineHost: 'peerbox', via: 'peerbox', type: 'codex', localTargetId: 'codex-box-4', kind: 'seat', aliases: ['stream-r4c3r'] }],
    ['claude-old-1', { peerHost: 'oldbox', machineHost: 'oldbox', via: 'oldbox', type: 'claude', localTargetId: 'claude-1' }],
  ]),
  federatedIdFor: () => null,
  resolveLocalAlias: () => null,
  resolveRemoteAlias: (n) => (String(n).toLowerCase() === 'stream-r4c3r' ? 'codex-box-4' : null),
};

async function main() {
  const listed = await server._handleToolCall('list_agents', {}, 'claude-1');
  const by = (id) => listed.find((a) => a.id === id);
  ok(by('codex-box-4').aliases?.includes('stream-r4c3r'),
    'a federated row advertises the claimed name (was hardcoded [])');
  ok((by('claude-old-1').aliases?.length ?? -1) === 0, 'a pre-aliases peer still renders an empty list');

  console.log('6. the send path accepts the remote claimed name');
  // The invariant from bug-17: anything the roster advertises must be sendable.
  // Here the name is not in OUR claim map and is not any local agent, so before
  // the fix this threw "Unknown agent".
  const resolved = [];
  server.session = { getAgent: () => null, id: 's1' };
  server.externalAgents = new Map();
  server.agentAliases = new Map();
  server.messageQueues = new Map();
  server.fipaHub = {
    inform: (from, to) => { resolved.push(to); return Promise.resolve({}); },
  };
  server.federationHub.resolveRemote = (id) => (id === 'codex-box-4' ? { peerHost: 'peerbox' } : null);
  let sendErr = null;
  try {
    await server._sendFipaMessage('inform', 'claude-1', 'stream-r4c3r', 'ping', null, null);
  } catch (e) { sendErr = e; }
  ok(!sendErr, `a remote claimed name is accepted by the send path${sendErr ? ` (threw: ${sendErr.message})` : ''}`);
  ok(resolved[0] === 'codex-box-4', 'and routes to its federatedId');

  let threw = null;
  try {
    await server._sendFipaMessage('inform', 'claude-1', 'no-such-name', 'ping', null, null);
  } catch (e) { threw = e; }
  ok(threw && /Unknown agent/.test(threw.message), 'an unclaimed name is still refused');

  console.log(`\n${failed === 0 ? 'OK' : 'FAILED'}: ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
