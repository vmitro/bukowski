#!/usr/bin/env node
// Federated chat room — single-host reflector, integration test.
//
// Boots the REAL FIPAHub + ConversationManager + ChatAgent with a stub ipcHub
// (captures fan-out) and a stub federation roster, wires the reflector exactly
// as multi.js does, and asserts: a message addressed to a locally-hosted room
//   (1) is recorded so the human's ChatPane renders it, and
//   (2) is fanned out to every OTHER agent (local by local-id + remote by
//       federated-id), attributed to the original sender, excluding the sender,
//       the room itself, and "user".
// A message NOT addressed to our room triggers no fan-out (no loop / no noise).

'use strict';

const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const ROOT = path.resolve(__dirname, '..', '..');
const { FIPAHub } = require(path.join(ROOT, 'src/acl/FIPAHub'));
const { ChatAgent } = require(path.join(ROOT, 'src/core/ChatAgent'));

// ── Stubs: a session + an ipcHub that captures every send (the fan-out) ──────
const sent = [];
const agentsMap = new Map();
const session = {
  id: 'sess-test',
  agents: agentsMap,
  getAllAgents: () => Array.from(agentsMap.values()),
  addAgent: (a) => agentsMap.set(a.id, a),
  getAgent: (id) => agentsMap.get(id),
};
class StubIpc extends EventEmitter {
  constructor() { super(); this.session = session; }
  send(from, to, method, payload, summary) { sent.push({ from, to, method }); }
}
const ipcHub = new StubIpc();
const fipaHub = new FIPAHub(ipcHub);

// Local pty agents + the room + another local room (must be excluded).
agentsMap.set('claude-1', { id: 'claude-1', type: 'claude', pty: {} });
agentsMap.set('claude-2', { id: 'claude-2', type: 'claude', pty: {} });
const CONV = '0ca8fac6-9ee5-44d3-a566-f3bfe593d2e4';
const ROOM = `chat-${CONV}`;
const room = new ChatAgent(CONV, fipaHub.conversations, fipaHub);
session.addAgent(room);
session.addAgent(new ChatAgent('11111111-2222-3333-4444-555555555555', fipaHub.conversations, fipaHub));

// Stub federation roster (two remote peers) + isFederatable / reflector, copied
// verbatim from multi.js so this exercises the same logic.
const federationHub = { remoteAgents: new Map([
  ['claude-1blu-1', {}], ['claude-netcup-1', {}],
]) };
const mcpServer = { getExternalAgents: () => [{ id: 'codex-bukowski-1', type: 'codex' }] };
const isFederatable = (agent) => !!agent && agent.type !== 'chat' && !!agent.pty;

function reflectRoomMessage(fipaMessage) {
  if (!fipaMessage || fipaMessage.receiver == null) return;
  const receivers = Array.isArray(fipaMessage.receiver) ? fipaMessage.receiver : [fipaMessage.receiver];
  const localRoomIds = new Set(session.getAllAgents().filter(a => a.type === 'chat').map(a => a.id));
  const rm = receivers.map(r => r?.name).find(n => localRoomIds.has(n));
  if (!rm) return;
  const sender = fipaMessage.sender?.name;
  const content = fipaMessage.content;
  const targets = new Set();
  for (const a of session.getAllAgents()) if (isFederatable(a)) targets.add(a.id);
  for (const a of (mcpServer.getExternalAgents?.() || [])) targets.add(a.id);
  for (const fid of federationHub.remoteAgents.keys()) targets.add(fid);
  targets.delete(sender); targets.delete(rm); targets.delete('user'); targets.delete(undefined);
  for (const to of targets) { try { fipaHub.inform(sender, to, content); } catch { /* per-target */ } }
}
fipaHub.conversations.on('message:received', ({ message }) => reflectRoomMessage(message));

// ── Act 1: a REMOTE agent posts to the room ─────────────────────────────────
sent.length = 0;
const before = room.messages.length;
fipaHub.inform('claude-1blu-1', ROOM, 'hi room, from 1blu');

// (1) human sees it — ChatAgent recorded the room-addressed message.
assert(room.messages.length > before, 'ChatPane recorded the room message (human sees it)');
assert(room.messages.some(m => m.sender === 'claude-1blu-1'), 'recorded with original sender');

// (2) fan-out = every send from the sender EXCEPT the one original delivery to
// the room id. The original `to=ROOM` naturally appears (that's the incoming
// message); the reflector must NOT add a second one, and must reach the others.
const originalToRoom = sent.filter(s => s.from === 'claude-1blu-1' && s.to === ROOM).length;
assert.strictEqual(originalToRoom, 1, 'room gets exactly the original send, not re-fanned to itself');
const fanTo = sent.filter(s => s.from === 'claude-1blu-1' && s.to !== ROOM).map(s => s.to);
assert(fanTo.includes('claude-1') && fanTo.includes('claude-2'), 'local pty agents fanned (local id)');
assert(fanTo.includes('codex-bukowski-1'), 'external bridge fanned');
assert(fanTo.includes('claude-netcup-1'), 'other remote peer fanned (federated id)');
assert(!fanTo.includes('claude-1blu-1'), 'sender excluded');
assert(!fanTo.some(t => t.startsWith('chat-')), 'no rooms in fan-out (no re-fan)');
assert(!fanTo.includes('user'), 'human excluded from fan-out (already saw original)');
console.log('room fan-out →', JSON.stringify(fanTo));

// ── Act 2: a normal DM (not to our room) triggers NO fan-out ────────────────
sent.length = 0;
fipaHub.inform('claude-1', 'claude-2', 'private, not a room');
const roomFan = sent.filter(s => s.from === 'claude-1' && s.to !== 'claude-2');
assert.strictEqual(roomFan.length, 0, 'non-room message does not fan out');

console.log('recorded-for-human · fan-out-to-all · sender/room/user excluded · no re-fan · DMs quiet');
console.log('OK: chat-room reflector integration smoke passed');

// ConversationManager keeps timers alive; exit cleanly so the suite doesn't hang.
try { fipaHub.shutdown(); } catch { /* ignore */ }
process.exit(0);
