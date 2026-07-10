#!/usr/bin/env node
// Multi-hop MESSAGE relay (the delivery half of the path-vector work).
//
// Roster forwarding makes a far agent VISIBLE; this makes it REACHABLE. A
// message to an agent several hubs away must travel hop-by-hop toward its
// `via`, with intermediate nodes relaying rather than dropping it as
// "misrouted". Topology: sender A — hub H — M (which owns meddaemon). H must
// relay A's message for meddaemon on to M, not deliver-or-drop it locally.

'use strict';

const assert = require('assert');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { FederationHub } = require(path.join(ROOT, 'src/federation/FederationHub'));

function fakePeer(host) {
  const outbox = [];
  return {
    host, machineHost: host + 'box', _stream: { buffer: '' },
    socket: { destroyed: false, write: (s) => outbox.push(JSON.parse(s)) },
    outbox,
  };
}
function feed(hub, peer, msg) {
  peer._stream.buffer = JSON.stringify(msg) + '\n';
  hub._consumeEstablishedBuffer(peer);
}

// Hub H with NO local agents; direct peers A (spoke) and M (owns meddaemon).
const H = new FederationHub({ host: 'hub', machineHost: 'hubbox', sessionId: 'Sh' });
const A = fakePeer('A');
const M = fakePeer('M');
H.peers.set('A', A);
H.peers.set('M', M);
// H learned meddaemon's agent THROUGH M (via = M, origin = medd).
H.remoteAgents.set('claude-medd-1', {
  peerHost: 'medd', machineHost: 'meddbox', via: 'M',
  localTargetId: 'claude-1', type: 'claude',
});

// 1) forwardIpcMessage routes to the NEXT HOP (via=M), not origin (medd).
const okd = H.forwardIpcMessage({ to: 'claude-medd-1', from: 'claude-A-1', payload: { hi: 1 } });
assert.strictEqual(okd, true, 'forwardIpcMessage returns true (routed)');
const toM = M.outbox.find(m => m.type === 'forward' && m.ipcMessage?._federatedTo === 'claude-medd-1');
assert(toM, 'message sent toward via=M, not origin=medd');
assert.strictEqual(toM.ipcMessage.to, 'claude-1', 'rewritten to origin local id');
assert(!A.outbox.some(m => m.ipcMessage), 'not sent to the wrong peer A');

// 2) An inbound forward for a non-local agent is RELAYED to via, not dropped.
A.outbox.length = 0; M.outbox.length = 0;
feed(H, A, {
  type: 'forward',
  ipcMessage: { to: 'claude-1', _federatedTo: 'claude-medd-1', payload: { hi: 2 } },
  hops: ['A'],
});
const relayed = M.outbox.find(m => m.type === 'forward' && m.ipcMessage?._federatedTo === 'claude-medd-1');
assert(relayed, 'intermediate hub relayed the forward to next hop M');
assert(relayed.hops.includes('hub'), 'hub appended itself to hops (loop suppression)');
assert(!A.outbox.some(m => m.type === 'forward'), 'did not bounce back to sender A');

// 3) Loop suppression: a forward whose hops already include us is dropped.
M.outbox.length = 0;
feed(H, A, {
  type: 'forward',
  ipcMessage: { to: 'claude-1', _federatedTo: 'claude-medd-1', payload: {} },
  hops: ['A', 'hub'],
});
assert(!M.outbox.some(m => m.type === 'forward'), 'looped forward not relayed');

console.log('forwardIpcMessage->via · intermediate relay · loop-suppress — all hold');
console.log('OK: multi-hop message relay smoke passed');
