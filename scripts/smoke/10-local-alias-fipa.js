#!/usr/bin/env node
// Local-alias FIPA addressing smoke. Regression guard for the gap where two
// agents on the SAME instance could not FIPA each other by the host-named
// federated id (claude-azra-agent-1): the federation advertises local agents
// to peers under those aliases, but _sendFipaMessage only resolved session ids
// (claude-N), externalAgents keys, and PEER-learned remoteAgents — its own
// aliases resolved nowhere and the send failed "Unknown agent" even though
// list_agents had just shown the id.
//
// In-process: a FederationHub (never start()ed — no sockets) with a stubbed
// local roster, attached to an MCPServer built on stub session/fipaHub/ipcHub.
// Asserts resolveLocalAlias() mapping, alias canonicalization in
// _sendFipaMessage (delivery lands on the LOCAL id, never routed out), and
// that a usable conversationId is returned (was always null — callers had
// nothing to correlate replies with, one root of the "fipa_request is broken"
// folklore).

'use strict';

const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const { FederationHub } = require(path.join(REPO, 'src', 'federation', 'FederationHub'));
const { MCPServer } = require(path.join(REPO, 'src', 'mcp', 'MCPServer'));

function fail(msg, extra) {
  console.error('FAIL:', msg);
  if (extra) console.error(extra);
  process.exit(1);
}

// ── FederationHub.resolveLocalAlias ────────────────────────────────────────
const fedHub = new FederationHub({
  host: 'azra-agent',
  sessionId: 'smoke',
  getLocalRoster: () => [
    { localId: 'claude-1', type: 'claude', federatedId: 'claude-azra-agent-1' },
    { localId: 'claude-2', type: 'claude', federatedId: 'claude-azra-agent-2' }
  ]
});

if (fedHub.resolveLocalAlias('claude-azra-agent-1') !== 'claude-1') {
  fail('resolveLocalAlias(claude-azra-agent-1) !== claude-1');
}
if (fedHub.resolveLocalAlias('claude-azra-agent-2') !== 'claude-2') {
  fail('resolveLocalAlias(claude-azra-agent-2) !== claude-2');
}
if (fedHub.resolveLocalAlias('claude-elsewhere-1') !== null) {
  fail('resolveLocalAlias of a foreign id must be null');
}
if (fedHub.resolveLocalAlias(null) !== null) {
  fail('resolveLocalAlias(null) must be null');
}
console.log('alias:  resolveLocalAlias maps claude-azra-agent-N -> claude-N, foreign -> null');

// ── _sendFipaMessage canonicalization ──────────────────────────────────────
const sent = [];
const stubSession = {
  // Only local session ids resolve here — the alias must NOT reach this map.
  getAgent: (id) => (id === 'claude-1' || id === 'claude-2' ? { id } : null),
  getAllAgents: () => []
};
const stubFipaHub = {
  inform: (from, to, content, opts) => { sent.push({ performative: 'inform', from, to, content, opts }); return Promise.resolve(null); },
  request: (from, to, content, opts) => { sent.push({ performative: 'request', from, to, content, opts }); return Promise.resolve(null); }
};
const stubIpcHub = {};

const mcp = new MCPServer(stubSession, stubFipaHub, stubIpcHub);
mcp.attachFederation(fedHub);

// 1. inform by host-named alias of a local agent → delivered to claude-1.
let res;
try { res = mcp._sendFipaMessage('inform', 'claude-2', 'claude-azra-agent-1', 'ping'); }
catch (e) { fail('inform to local alias threw: ' + e.message); }
if (sent.length !== 1 || sent[0].to !== 'claude-1') {
  fail('inform to alias not canonicalized to claude-1', JSON.stringify(sent));
}
if (!res || res.success !== true || typeof res.conversationId !== 'string' || !res.conversationId) {
  fail('inform must return success + non-null conversationId', JSON.stringify(res));
}
console.log(`fipa:   inform to claude-azra-agent-1 delivered as claude-1 (conversationId=${res.conversationId.slice(0, 8)}…)`);

// 2. request the other direction, with explicit conversationId passthrough.
let res2;
try { res2 = mcp._sendFipaMessage('request', 'claude-1', 'claude-azra-agent-2', 'do it', 'conv-42'); }
catch (e) { fail('request to local alias threw: ' + e.message); }
if (sent.length !== 2 || sent[1].to !== 'claude-2' || sent[1].performative !== 'request') {
  fail('request to alias not canonicalized to claude-2', JSON.stringify(sent));
}
if (sent[1].opts?.conversationId !== 'conv-42' || res2.conversationId !== 'conv-42') {
  fail('explicit conversationId must thread through send and result', JSON.stringify({ res2, opts: sent[1].opts }));
}
console.log('fipa:   request to claude-azra-agent-2 delivered as claude-2, conversationId threads through');

// 3. genuinely unknown id still rejects.
let threw = false;
try { mcp._sendFipaMessage('inform', 'claude-1', 'claude-nowhere-9', 'hi'); }
catch (e) { threw = /Unknown agent/.test(e.message); }
if (!threw) fail('unknown id must still throw "Unknown agent"');
console.log('fipa:   unknown id still rejected');

console.log('OK: local-alias FIPA addressing smoke passed');
process.exit(0);
