#!/usr/bin/env node
// Path-vector roster forwarding + truthful machine identity.
//
// Two things this asserts, both introduced to make a hub-and-spoke topology
// (phone → home → netcup-as-hub) actually work:
//
//   A. machineHost travels with every roster entry, so list_agents can tell
//      two same-named "bukowski" boxes apart (host = true machine, via = hop).
//   B. A hub RELAYS a spoke's agents to its other spokes (transitive), with
//      split-horizon (no echo to the source), loop suppression (a delta whose
//      path already includes us is dropped), late-join sync, and removal
//      propagation when a neighbour drops.
//
// Driven at the handler level with fake peers so we can force a LINE topology
// A—H—C (A and C never directly linked) that PeerRegistry's auto-discovery
// would otherwise collapse into a full mesh.

'use strict';

const assert = require('assert');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { FederationHub } = require(path.join(ROOT, 'src/federation/FederationHub'));
const { machineHost } = require(path.join(ROOT, 'src/utils/host'));

function fakePeer(host, mHost) {
  const outbox = [];
  return {
    host, machineHost: mHost, _stream: { buffer: '' },
    socket: { destroyed: false, write: (s) => outbox.push(JSON.parse(s)) },
    outbox,
  };
}
function feed(hub, peer, msg) {
  peer._stream.buffer = JSON.stringify(msg) + '\n';
  hub._consumeEstablishedBuffer(peer);
}

// ── A. machineHost is truthful + distinct from the cwd routing host ──────────
const mh = machineHost();
assert(/^[A-Za-z0-9_-]+$/.test(mh) && mh !== 'unknown', `machineHost sane: ${mh}`);

// ── B. path-vector forwarding through a hub ──────────────────────────────────
const H = new FederationHub({ host: 'hub', machineHost: 'netcup', sessionId: 'Shub' });
const A = fakePeer('A', 'abox');
const C = fakePeer('C', 'cbox');
H.peers.set('A', A);
H.peers.set('C', C);

// C announces its local agent → H records it and relays to A, not back to C.
feed(H, C, {
  type: 'roster', op: 'add',
  agent: { federatedId: 'claude-C-1', localId: 'claude-1', type: 'claude' },
  origin: { host: 'C', machineHost: 'cbox' }, path: ['C'],
});
const e = H.remoteAgents.get('claude-C-1');
assert(e && e.via === 'C' && e.machineHost === 'cbox', 'H records C-1 via C, truthful machine');
const relayed = A.outbox.find(m => m.agent?.federatedId === 'claude-C-1' && m.op === 'add');
assert(relayed, 'transitive: H relays C-1 to spoke A');
assert.deepStrictEqual(relayed.path, ['C', 'hub'], 'path grows [C, hub]');
assert.strictEqual(relayed.origin.machineHost, 'cbox', 'A sees C-1 true origin machine');
assert(!C.outbox.some(m => m.agent?.federatedId === 'claude-C-1'), 'split-horizon: no echo to C');

// A delta already carrying our host is a loop → dropped.
const n = H.remoteAgents.size;
feed(H, C, {
  type: 'roster', op: 'add',
  agent: { federatedId: 'claude-X-1', localId: 'claude-1', type: 'claude' },
  origin: { host: 'X', machineHost: 'xbox' }, path: ['X', 'hub'],
});
assert.strictEqual(H.remoteAgents.size, n, 'loop delta ignored');

// Late joiner gets the transitive entry on sync.
const A2 = fakePeer('A2', 'a2box');
H.peers.set('A2', A2);
H._syncRosterTo(A2);
assert(A2.outbox.some(m => m.agent?.federatedId === 'claude-C-1'), 'late joiner syncs transitive C-1');

// Neighbour C drops → purge by via + propagate removal to A.
A.outbox.length = 0;
H._purgePeerRoster('C');
assert(!H.remoteAgents.has('claude-C-1'), 'purge on neighbour loss');
assert(A.outbox.some(m => m.op === 'remove' && m.agent?.federatedId === 'claude-C-1'), 'removal propagated');

console.log(`machineHost() = ${mh}`);
console.log('transitive add · split-horizon · loop-suppress · late-sync · purge+propagate — all hold');
console.log('OK: path-vector federation smoke passed');
