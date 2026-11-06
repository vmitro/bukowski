#!/usr/bin/env node
// @chat reachability smoke. Regression guard for the defect where EVERY
// `@chat` broadcast answered "no reachable agents for @chat — nothing sent".
//
// bug-5(b) hardened getReachableAgents so the local half only lists agents
// with a live delivery path, using ipcHub.isAgentConnected. That predicate
// asks the wrong registry: claude/codex agents connect to the MCP socket, so
// they live in MCPServer's `clients`/`externalAgents` and NEVER appear in
// ipcHub.agentSockets — which is populated only by a client that dials
// IPCHub's own master socket and sends {type:'register'}, something nothing
// in the tree does. Measured on the live box: 0 connections across every
// /tmp/bukowski/session-*.sock, against 33 on the bukowski-mcp-*.sock
// family. So the local half was always empty and @chat could never send.
// @swarm kept working because the federated half does not consult IPCHub.
//
// Two levels, because the bug needed both to be visible:
//   1. MCPServer.isAgentReachable — the missing predicate.
//   2. The roster filter composed from BOTH registries, and ChatAgent.send
//      actually reaching a target. The filter is replicated here the way
//      13-chat-room-reflector replicates the reflector's target set.

'use strict';

const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const { MCPServer } = require(path.join(ROOT, 'src', 'mcp', 'MCPServer'));
const { ChatAgent } = require(path.join(ROOT, 'src', 'core', 'ChatAgent'));

const PANES = [
  { id: 'claude-1', name: 'Claude', type: 'claude' },
  { id: 'codex-1', name: 'Codex', type: 'codex' },
];

const session = { getAllAgents: () => PANES, getAgent: (id) => PANES.find(a => a.id === id) || null };
const server = new MCPServer(session, null, null, null);

// A bridge connection that identified as claude-1 — exactly what a claude
// pane's MCP bridge does, and what IPCHub never sees.
const liveSocket = { destroyed: false, write() { return true; } };
server.clients.set(liveSocket, { agentId: 'claude-1' });
// A codex seat registered through the external-agent path.
server.externalAgents.set('codex-1', { type: 'codex', host: 'testbox', socket: liveSocket });
// A seat whose connection has gone away must NOT count as reachable.
const deadSocket = { destroyed: true, write() { return false; } };
server.externalAgents.set('codex-9', { type: 'codex', host: 'testbox', socket: deadSocket });

// ── 1. The predicate ───────────────────────────────────────────────────────
assert.strictEqual(server.isAgentReachable('claude-1'), true,
  'a pane with a live bridge connection is reachable');
assert.strictEqual(server.isAgentReachable('codex-1'), true,
  'a registered external seat is reachable');
assert.strictEqual(server.isAgentReachable('codex-9'), false,
  'a destroyed socket is not reachable');
assert.strictEqual(server.isAgentReachable('claude-404'), false,
  'an unknown id is not reachable');
assert.strictEqual(server.isAgentReachable(null), false, 'null is not reachable');
console.log('predicate: bridge client + external seat reachable; destroyed/unknown/null not');

// ── 2. The roster filter, both registries ──────────────────────────────────
// IPCHub as it actually is on a running instance: nothing ever connected.
const ipcHub = { isAgentConnected: () => false };

function getReachableLocal(mcpServer) {
  return session.getAllAgents()
    .filter(a => a.type !== 'chat')
    .filter(a => ipcHub.isAgentConnected(a.id) || mcpServer?.isAgentReachable?.(a.id))
    .map(a => ({ id: a.id, name: a.name, type: a.type, source: 'session' }));
}

const reachable = getReachableLocal(server);
assert.deepStrictEqual(reachable.map(a => a.id), ['claude-1', 'codex-1'],
  `@chat roster must list the MCP-reachable panes, got ${JSON.stringify(reachable.map(a => a.id))}`);

// The bug, stated as the counterfactual: ask IPCHub alone and you get nobody.
const ipcOnly = session.getAllAgents().filter(a => ipcHub.isAgentConnected(a.id));
assert.strictEqual(ipcOnly.length, 0,
  'IPCHub alone sees nobody — this is what made @chat dead, keep it asserted');
console.log(`roster:    both registries -> ${reachable.length} targets; IPCHub alone -> ${ipcOnly.length}`);

// ── 3. ChatAgent.send actually reaches them ────────────────────────────────
{
  const sent = [];
  const conversations = { getConversation: () => null, on() {} };
  const fipaHub = {
    conversations,
    inform: (from, to, content, opts) => { sent.push({ from, to, content, opts }); return null; },
    on() {},
  };

  const chat = new ChatAgent('conv-smoke', conversations, fipaHub);
  chat.setAvailableAgents(reachable);
  chat.targetAgent = '@chat';
  chat.inputBuffer = 'ping';
  chat.send();

  const errors = (chat.messages || []).filter(m => /no reachable agents/.test(m.content || ''));
  assert.strictEqual(errors.length, 0,
    `@chat must not report an empty roster: ${JSON.stringify(errors.map(e => e.content))}`);
  assert.strictEqual(sent.length, 1, '@chat issues ONE multi-receiver FIPA, not N');
  assert.deepStrictEqual(sent[0].to, ['claude-1', 'codex-1'],
    `both panes must receive it, got ${JSON.stringify(sent[0].to)}`);
  console.log(`send:      @chat -> ${JSON.stringify(sent[0].to)} in 1 message, no error line`);
}

// ── 4. The empty case must still say so ────────────────────────────────────
// bug-5(c): a broadcast into a genuinely empty roster used to render as sent.
// Fixing the predicate must not silence the real "nobody there" signal.
{
  const sent = [];
  const conversations = { getConversation: () => null, on() {} };
  const fipaHub = { conversations, inform: (...a) => { sent.push(a); }, on() {} };

  const chat = new ChatAgent('conv-empty', conversations, fipaHub);
  chat.setAvailableAgents([]);
  chat.targetAgent = '@chat';
  chat.inputBuffer = 'anyone?';
  chat.send();

  const errors = (chat.messages || []).filter(m => /no reachable agents/.test(m.content || ''));
  assert.strictEqual(sent.length, 0, 'an empty roster must send nothing');
  assert.strictEqual(errors.length, 1, 'an empty roster must still report it');
  console.log('empty:     genuinely empty roster still errors (bug-5(c) preserved)');
}

console.log('OK: chat reachability smoke passed');
process.exit(0);
