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

// ── FederationHub.federatedIdFor (forward map, used to key coordination events)
// Events must be published/subscribed under the GLOBALLY-UNIQUE federated id,
// not the box-local one, or a same-numbered agent on another box collides.
if (fedHub.federatedIdFor('claude-1') !== 'claude-azra-agent-1') {
  fail('federatedIdFor(claude-1) !== claude-azra-agent-1');
}
if (fedHub.federatedIdFor('claude-2') !== 'claude-azra-agent-2') {
  fail('federatedIdFor(claude-2) !== claude-azra-agent-2');
}
// Round-trips with its inverse.
if (fedHub.resolveLocalAlias(fedHub.federatedIdFor('claude-1')) !== 'claude-1') {
  fail('federatedIdFor/resolveLocalAlias not inverse');
}
if (fedHub.federatedIdFor('claude-99') !== null) {
  fail('federatedIdFor of an unknown local id must be null (caller falls back to id as-given)');
}
if (fedHub.federatedIdFor(null) !== null) {
  fail('federatedIdFor(null) must be null');
}
console.log('alias:  federatedIdFor maps claude-N -> claude-azra-agent-N (inverse of resolveLocalAlias)');

// ── _sendFipaMessage canonicalization ──────────────────────────────────────
const sent = [];
const stubSession = {
  // Only local session ids resolve here — the alias must NOT reach this map.
  getAgent: (id) => (id === 'claude-1' || id === 'claude-2' ? { id } : null),
  getAllAgents: () => []
};
const stubFipaHub = {
  inform: (from, to, content, opts) => { sent.push({ performative: 'inform', from, to, content, opts }); return Promise.resolve(null); },
  request: (from, to, content, opts) => { sent.push({ performative: 'request', from, to, content, opts }); return Promise.resolve(null); },
  queryRef: (from, to, content, opts) => { sent.push({ performative: 'query-ref', from, to, content, opts }); return Promise.resolve(null); },
  queryIf: (from, to, content, opts) => { sent.push({ performative: 'query-if', from, to, content, opts }); return Promise.resolve(null); }
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

// ── event_publish fire-into-void warning is federation-aware ────────────────
// EventBus counts subscribers on THIS instance only; under federation the event
// still forwards to peers whose subscribers we can't see. So a bare "nothing
// listens" is a false alarm when peers are connected — the handler must reword
// it to scope the claim to local knowledge (loose-end #2 from the cross-box fix).
(async () => {
  // No peers connected → the base "nothing listens" warning stands verbatim.
  fedHub.connectedHosts = () => [];
  const v1 = await mcp._handleToolCall('event_publish', { topic: 'azra:rail:corpus', payload: { n: 1 } }, 'claude-1');
  if (v1.subscribers !== 0 || !/nothing listens/.test(v1.warning || '')) {
    fail('no-peers publish to an unheard topic must keep the bare "nothing listens" warning', JSON.stringify(v1));
  }
  console.log('event:  no peers → bare fire-into-void warning preserved');

  // Peers connected → warning reworded to local-only scope, names the peers.
  fedHub.connectedHosts = () => ['azra', 'meddaemon'];
  const v2 = await mcp._handleToolCall('event_publish', { topic: 'azra:rail:corpus', payload: { n: 2 } }, 'claude-1');
  if (v2.subscribers !== 0) fail('still no LOCAL subscribers', JSON.stringify(v2));
  if (/nothing listens/.test(v2.warning || '') || !/no LOCAL listeners/.test(v2.warning || '')) {
    fail('with peers connected, warning must be reworded away from asserting the void', JSON.stringify(v2));
  }
  if (!/azra, meddaemon/.test(v2.warning) || !/2 peer\(s\)/.test(v2.warning)) {
    fail('reworded warning must name the peers it forwarded to', JSON.stringify(v2));
  }
  console.log('event:  peers connected → warning scoped to local knowledge, names forward targets');

  // A real LOCAL subscriber → no warning at all, regardless of peers.
  mcp.eventBus.subscribe('claude-azra-agent-1', 'azra:rail:*');
  const v3 = await mcp._handleToolCall('event_publish', { topic: 'azra:rail:corpus', payload: { n: 3 } }, 'claude-2');
  if (v3.subscribers < 1 || v3.warning) {
    fail('a local subscriber must yield subscribers>=1 and no warning', JSON.stringify(v3));
  }
  console.log('event:  a local subscriber suppresses the warning entirely');

  // ── `content` is a universal alias for the performative-specific payload ──
  // FIPA names each slot distinctly (reference/proposition/action/...); agents
  // reach for `content` by muscle-memory. {to, content} to fipa_query_ref used
  // to silently omit `reference` and hard-fail (orbis-mock-1 report). Now
  // `content` fills the slot; the canonical name still wins when both present.
  sent.length = 0;
  await mcp._handleToolCall('fipa_query_ref', { to: 'claude-1', content: 'what is the corpus size?' }, 'claude-2');
  if (sent.length !== 1 || sent[0].performative !== 'query-ref' || sent[0].content !== 'what is the corpus size?') {
    fail('fipa_query_ref must accept `content` as an alias for `reference`', JSON.stringify(sent));
  }
  console.log('alias:  fipa_query_ref accepts `content` in place of `reference`');

  sent.length = 0;
  await mcp._handleToolCall('fipa_query_if', { to: 'claude-1', reference: 'wrong-slot', content: 'is it up?' }, 'claude-2');
  if (sent.length !== 1 || sent[0].performative !== 'query-if' || sent[0].content !== 'is it up?') {
    fail('fipa_query_if must accept `content` as an alias for `proposition`', JSON.stringify(sent));
  }
  console.log('alias:  fipa_query_if accepts `content` in place of `proposition`');

  sent.length = 0;
  await mcp._handleToolCall('fipa_query_ref', { to: 'claude-1', reference: 'canonical wins', content: 'ignored' }, 'claude-2');
  if (sent.length !== 1 || sent[0].content !== 'canonical wins') {
    fail('canonical field must win over the `content` alias when both are present', JSON.stringify(sent));
  }
  console.log('alias:  canonical field wins over `content` when both supplied');

  let aliasThrew = '';
  try { await mcp._handleToolCall('fipa_query_ref', { to: 'claude-1' }, 'claude-2'); }
  catch (e) { aliasThrew = e.message; }
  if (!/reference/.test(aliasThrew) || !/content/.test(aliasThrew)) {
    fail('missing payload error must name both the canonical field and the `content` alias', aliasThrew);
  }
  console.log('alias:  missing-payload error names the canonical field AND the content alias');

  console.log('OK: local-alias FIPA addressing smoke passed');
  process.exit(0);
})().catch((e) => fail('event-publish warning block threw: ' + e.message));
