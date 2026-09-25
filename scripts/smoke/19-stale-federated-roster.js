#!/usr/bin/env node
// Regression: a federated agent is only as addressable as the link it lives
// behind, and a send with no reachable target must say so.
//
//   bug-5  Three ways a dead agent kept looking alive:
//
//          (a) _ingestPeerRoster was purely additive. A hello carries the
//              peer's CURRENT roster, but an agent the peer had dropped
//              survived every reconnect — the link never tore down, so
//              _purgePeerRoster (keyed on `via`) never ran and nothing else
//              could evict it.
//          (b) getReachableAgents filtered the LOCAL half by liveness
//              (ipcHub.isAgentConnected) and the federated half not at all,
//              so ids behind a dropped neighbour stayed in the picker and in
//              every @swarm fan-out.
//          (c) ChatAgent.send returned silently on zero targets, so a
//              broadcast into an all-stale roster rendered as sent.
//
// Pure/fast: drives FederationHub's roster bookkeeping and ChatAgent.send
// directly. No sockets, no PTY — see 03-federation.js for the wire test.

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { FederationHub } = require(path.join(ROOT, 'src', 'federation', 'FederationHub'));
const { ChatAgent } = require(path.join(ROOT, 'src', 'core', 'ChatAgent'));

let failed = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${msg}`);
  if (!cond) failed++;
};

// A hub with a fake connected neighbour; nothing listens, nothing dials.
function hub(host = 'local') {
  const h = new FederationHub({ host, sessionId: 's1' });
  h.fanned = [];
  h._fanRosterDelta = (entry, from) => h.fanned.push({ ...entry, from });
  h.connect = (peerHost) => h.peers.set(peerHost, { host: peerHost, socket: {} });
  return h;
}
const agent = (fid, localId) => ({ federatedId: fid, localId, type: 'claude' });

// ── 1. A hello is authoritative about the peer's OWN agents ────────────────
{
  const h = hub();
  h.connect('azra');
  h._ingestPeerRoster('azra', [agent('claude-azra-1', 'claude-1'), agent('claude-azra-2', 'claude-2')], 'azra');
  ok(h.remoteAgents.size === 2, 'first hello records both of the peer\'s agents');

  // The peer restarts with one agent gone; the LINK never dropped, so
  // _purgePeerRoster never runs. Only the reconcile can evict it.
  h.fanned = [];
  h._ingestPeerRoster('azra', [agent('claude-azra-1', 'claude-1')], 'azra');
  ok(!h.remoteAgents.has('claude-azra-2'), 'an agent the new hello omits is dropped');
  ok(h.remoteAgents.has('claude-azra-1'), 'an agent it still lists survives');
  const removals = h.fanned.filter((f) => f.op === 'remove');
  ok(removals.length === 1 && removals[0].agent.federatedId === 'claude-azra-2',
    'the removal is propagated to the rest of the mesh');
}

// ── 2. Agents merely RELAYED by that peer must survive its hello ───────────
{
  const h = hub();
  h.connect('relay');
  // Learned through `relay`, but owned by `far` — a hello from relay does not
  // restate these, so reconciling them away would blank the far side.
  h.remoteAgents.set('claude-far-1', {
    peerHost: 'far', machineHost: 'far', via: 'relay', path: ['relay', 'far'],
    localTargetId: 'claude-1', type: 'claude',
  });
  h._ingestPeerRoster('relay', [agent('claude-relay-1', 'claude-1')], 'relay');
  ok(h.remoteAgents.has('claude-far-1'), 'a transit agent survives its relay\'s hello');
  ok(h.remoteAgents.has('claude-relay-1'), 'and the relay\'s own agent is recorded');
}

// ── 3. Reachability follows the link, not the map ──────────────────────────
{
  const h = hub();
  h.connect('azra');
  h._ingestPeerRoster('azra', [agent('claude-azra-1', 'claude-1')], 'azra');
  ok(h.isRemoteReachable('claude-azra-1'), 'reachable while the neighbour is connected');
  h.peers.delete('azra');
  ok(!h.isRemoteReachable('claude-azra-1'), 'unreachable the moment the neighbour goes');
  ok(h.remoteAgents.has('claude-azra-1'),
    'but still in remoteAgents — routing state outlives the link by design');
  ok(!h.isRemoteReachable('claude-nobody-9'), 'an id we never knew is not reachable');
}

// ── 4. The roster snapshot multi.js builds drops unreachable federated ids ─
// Mirrors getReachableAgents' federated half verbatim.
{
  const h = hub();
  h.connect('azra');
  h._ingestPeerRoster('azra', [agent('claude-azra-1', 'claude-1'), agent('claude-azra-2', 'claude-2')], 'azra');
  h.connect('vlad');
  h._ingestPeerRoster('vlad', [agent('claude-vlad-1', 'claude-1')], 'vlad');
  const snapshot = () => Array.from(h.remoteAgents.entries())
    .filter(([fid]) => h.isRemoteReachable(fid))
    .map(([fid]) => fid);
  ok(snapshot().length === 3, 'all three federated agents listed while both links are up');
  h.peers.delete('azra');
  ok(snapshot().join(',') === 'claude-vlad-1', 'azra\'s agents leave the roster with azra');
}

// ── 5. A send with no reachable target is reported, not swallowed ──────────
{
  const mk = (available) => {
    const c = Object.create(ChatAgent.prototype);
    c.messages = [];
    c.inputBuffer = 'hello swarm';
    c.inputCursor = 0;
    c.conversationId = 'c1';
    c.performative = 'inform';
    c._availableAgents = available;
    c.sent = [];
    c.fipaHub = { inform: (from, to) => c.sent.push(to) };
    c._render = () => {};
    c.emit = () => {};
    return c;
  };

  const empty = mk([]);
  empty.targetAgent = '@swarm';
  empty.send();
  ok(empty.sent.length === 0, 'nothing is sent when there is nobody to send to');
  const err = empty.messages.find((m) => m.performative === 'failure');
  ok(!!err, 'a zero-target broadcast reports a failure instead of returning silently');
  ok(err && err.content.includes('@swarm'), 'the failure names the handle that had no targets');
  ok(empty.inputBuffer === 'hello swarm',
    'the unsent text is kept so it can be retried when a peer comes back');

  const live = mk([{ id: 'claude-azra-1', type: 'claude', source: 'federated' }]);
  live.targetAgent = '@swarm';
  live.send();
  ok(live.sent.length === 1, 'a broadcast with a live target still goes out');
  ok(!live.messages.some((m) => m.performative === 'failure'), 'and reports no failure');
}

if (failed > 0) {
  console.log(`${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('stale-federated-roster OK');
