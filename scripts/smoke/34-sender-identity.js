#!/usr/bin/env node
// Sender-identity stamping smoke. Regression guard for bug-32: a FIPA message
// delivered to a SAME-INSTANCE recipient carried a bare seat ordinal in
// sender.name ("claude-2"), while the same seat sending CROSS-INSTANCE was
// correctly federated ("claude-host-2"). IPCHub.routeMessage stamped the
// federated form only on its federation-handoff branch; the local-socket
// branch delivered the message untouched. FIPAHub.send also records the
// conversation BEFORE routing, so the index stored the pre-stamp bare id on
// EVERY hop — which is how one seat could appear twice in its own thread,
// bare from its own send and federated from the inbound copy.
//
// A bare ordinal is correct inside its own instance, so there is no local
// victim; the harm is that the string travels. A peer reading it resolves
// local-wins against its OWN seat of that number.
//
// The test is deliberately shaped as the CONTRAST that settled the bug, not
// as a count: one same-instance send and one cross-instance send, asserted
// against the DELIVERED message. A count over one arm cannot discriminate —
// cross-instance was always federated, under the defect and after the fix.
//
// In-process: no sockets. agentSockets gets a dummy entry so routeMessage
// takes the local branch, and deliverToSocket/forwardIpcMessage are replaced
// with capture hooks.

'use strict';

const path = require('path');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..', '..');
const { IPCHub } = require(path.join(REPO, 'src', 'ipc', 'IPCHub'));
const { FIPAHub } = require(path.join(REPO, 'src', 'acl', 'FIPAHub'));

const HOST = 'testbox';
const FED = { 'claude-1': `claude-${HOST}-1`, 'claude-2': `claude-${HOST}-2` };

function makeHub() {
  const agents = new Map([
    ['claude-1', { id: 'claude-1', name: 'Claude', type: 'claude' }],
    ['claude-2', { id: 'claude-2', name: 'Claude', type: 'claude' }],
  ]);
  const session = {
    id: 'smoke-sender-identity',
    agents,
    getAgent: (id) => agents.get(id) || null,
    getAllAgents: () => [...agents.values()],
  };

  const ipcHub = new IPCHub(session, '/tmp/bukowski-smoke-sender-identity');
  const captured = { local: [], forwarded: [] };

  // Local branch: a truthy socket entry is all routeMessage needs.
  ipcHub.agentSockets.set('claude-2', { write() {} });
  ipcHub.deliverToSocket = (_socket, message) => captured.local.push(message);

  ipcHub.attachFederation({
    resolveRemote: (id) => (id === 'claude-elsewhere-1' ? { via: 'elsewhere' } : null),
    forwardIpcMessage: (message) => { captured.forwarded.push(message); return true; },
    // Same router multi.js installs: local id -> federated, anything else as-is.
    federateSenderId: (localId) => FED[localId] || localId,
  });

  return { ipcHub, fipaHub: new FIPAHub(ipcHub), captured };
}

const senderOf = (m) => m?.payload?._fipaMessage?.sender?.name;

// ── The contrast: same-instance vs cross-instance, same sender ─────────────
{
  const { fipaHub, captured } = makeHub();

  fipaHub.inform('claude-1', 'claude-2', 'same-instance hop');
  fipaHub.inform('claude-1', 'claude-elsewhere-1', 'cross-instance hop');

  assert.strictEqual(captured.local.length, 1, 'same-instance send must deliver locally');
  assert.strictEqual(captured.forwarded.length, 1, 'cross-instance send must be forwarded');

  const localArm = senderOf(captured.local[0]);
  const remoteArm = senderOf(captured.forwarded[0]);

  // The bug: localArm was 'claude-1' while remoteArm was 'claude-testbox-1'.
  assert.strictEqual(localArm, `claude-${HOST}-1`,
    `same-instance delivery must carry the federated sender, got ${localArm}`);
  assert.strictEqual(remoteArm, `claude-${HOST}-1`,
    `cross-instance delivery must carry the federated sender, got ${remoteArm}`);
  assert.strictEqual(localArm, remoteArm, 'both hops must agree on the sender');

  // The IPC-level `from` stays LOCAL on the local hop: IPCHub routes and skips
  // broadcast echoes by local id. The handoff branch federates it for the wire.
  assert.strictEqual(captured.local[0].from, 'claude-1',
    'local hop keeps the local IPC from (routing identity)');
  assert.strictEqual(captured.forwarded[0].from, `claude-${HOST}-1`,
    'forwarded hop federates the IPC from so replies can route back');

  console.log(`contrast: same-instance=${localArm} cross-instance=${remoteArm} (was claude-1 / claude-${HOST}-1)`);
}

// ── The index, which is the transport ──────────────────────────────────────
// Recorded before routing, so it must be stamped at send time or it keeps a
// bare ordinal on every hop and shows one seat under two identities.
{
  const { fipaHub, captured } = makeHub();
  fipaHub.inform('claude-1', 'claude-2', 'indexed');

  const convId = captured.local[0].payload._fipaMessage.conversationId;
  const conv = fipaHub.conversations.getConversation(convId);
  assert.ok(conv, 'conversation must be recorded');
  assert.strictEqual(conv.initiator, `claude-${HOST}-1`,
    `index initiator must be federated, got ${conv.initiator}`);

  // getSummary() is what the get_conversations tool reports, and its
  // participants are derived from the messages — so this is the field agents
  // actually read, not an internal index. It must be non-empty or the
  // assertion below proves nothing.
  const summary = conv.getSummary();
  const participants = summary.participants;
  assert.ok(Array.isArray(participants) && participants.length >= 2,
    `participants must be populated or this check is vacuous, got ${JSON.stringify(participants)}`);
  assert.strictEqual(summary.initiator, `claude-${HOST}-1`,
    'getSummary initiator must be federated too');
  assert.ok(!participants.includes('claude-1'),
    `no bare SENDER ordinal in participants, got ${JSON.stringify(participants)}`);

  // SCOPE, asserted so it is not mistaken for fixed: this change stamps the
  // SENDER only. The receiver is still recorded under the name the sender
  // addressed, which for a same-instance send is the bare local id. Stamping
  // it too would change routing (the receiver name is what IPCHub routes on),
  // so receiver identity is tracked separately as bug-33. This assertion
  // documents the remaining gap and will fail loudly if someone fixes the
  // receiver half without updating it.
  assert.ok(participants.includes('claude-2'),
    `receiver is still bare in the index (bug-33); got ${JSON.stringify(participants)}`);

  console.log(`index:    initiator=${summary.initiator} participants=${JSON.stringify(participants)}`);
  console.log('scope:    sender stamped; receiver still bare on a local hop (bug-33)');
}

// ── Idempotence and the non-federatable senders ────────────────────────────
// Re-stamping an already-federated sender must be a no-op (a reflected room
// message is re-sent under the name it arrived with), and 'user' / an unknown
// id must pass through untouched — the router returns those unchanged, and a
// rewrite would break the `sender === 'user'` checks the chat panes rely on.
{
  const { fipaHub, captured } = makeHub();

  fipaHub.inform(`claude-${HOST}-1`, 'claude-2', 'already federated');
  assert.strictEqual(senderOf(captured.local[0]), `claude-${HOST}-1`,
    'an already-federated sender must survive unchanged');

  fipaHub.inform('user', 'claude-2', 'from the human');
  assert.strictEqual(senderOf(captured.local[1]), 'user',
    "'user' must never be federated");

  console.log("passthrough: already-federated stable, 'user' untouched");
}

// ── No federation attached ─────────────────────────────────────────────────
// A single-instance run has no router. The send must still work and keep the
// local id rather than throwing on the missing lookup.
{
  const agents = new Map([['claude-2', { id: 'claude-2', name: 'Claude', type: 'claude' }]]);
  const session = {
    id: 'smoke-sender-identity-solo', agents,
    getAgent: (id) => agents.get(id) || null, getAllAgents: () => [...agents.values()],
  };
  const ipcHub = new IPCHub(session, '/tmp/bukowski-smoke-sender-identity');
  const seen = [];
  ipcHub.agentSockets.set('claude-2', { write() {} });
  ipcHub.deliverToSocket = (_s, m) => seen.push(m);

  const fipaHub = new FIPAHub(ipcHub);
  fipaHub.inform('claude-1', 'claude-2', 'no federation here');

  assert.strictEqual(seen.length, 1, 'unfederated send must still deliver');
  assert.strictEqual(senderOf(seen[0]), 'claude-1',
    'without a router the local id stands');

  console.log('solo:     no federation router -> local id kept, no throw');
}

console.log('OK: sender-identity stamping smoke passed');
// ConversationManager keeps sweep timers; nothing left to await.
process.exit(0);
