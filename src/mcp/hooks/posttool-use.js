#!/usr/bin/env node
// PostToolUse hook for Claude Code agents launched by bukowski.
//
// Fires after every tool call during a turn. Used for *mid-turn interrupts*:
// only `request` performatives qualify (deliberate, narrow scope — `inform`,
// `query_*`, etc. wait for turn-boundary delivery via Stop/UserPromptSubmit).
// Each request is announced at most once per arrival; the server marks it via
// `bukowski/peek_unannounced_requests` so subsequent PostToolUse calls in the
// same turn don't re-announce.
//
// Output: when there's at least one unannounced request, write JSON
// `{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "..."}}`
// — Claude Code feeds `additionalContext` into the next inference call so the
// agent sees the request between tool steps.
//
// Quietly no-ops on missing env, broken socket, or any error.

'use strict';

const net = require('net');
const fs = require('fs');

const HOOK_TIMEOUT_MS = parseInt(process.env.BUKOWSKI_HOOK_TIMEOUT_MS, 10) || 600;

function quietExit() { process.exit(0); }

const agentId = process.env.BUKOWSKI_AGENT_ID;
const socketPath = process.env.BUKOWSKI_MCP_SOCKET;
if (!agentId || !socketPath) quietExit();
try { if (!fs.existsSync(socketPath)) quietExit(); } catch { quietExit(); }

// Drain stdin (Claude Code passes the tool-event JSON; we don't need it).
process.stdin.on('data', () => {});
process.stdin.on('error', () => {});
process.stdin.resume();

const overall = setTimeout(quietExit, HOOK_TIMEOUT_MS);

const sock = net.createConnection(socketPath);
let buf = '';
let nextId = 1;
const pending = new Map();

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

sock.on('error', quietExit);
sock.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const p = msg.id != null ? pending.get(msg.id) : null;
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'rpc error'));
      else p.resolve(msg.result);
    }
  }
});

sock.once('connect', async () => {
  try {
    await rpc('initialize', { agentId });
    const peek = await rpc('bukowski/peek_unannounced_requests', { agentId });
    sock.end();
    clearTimeout(overall);

    const count = peek?.count || 0;
    if (count <= 0) quietExit();

    const previews = (peek.previews || []).map((p) => {
      const sender = p.sender || 'unknown';
      const excerpt = (p.excerpt || '').replace(/\s+/g, ' ');
      return `  - request from ${sender}: ${excerpt}`;
    }).join('\n');

    const text = [
      `[bukowski FIPA — mid-turn interrupt] ${count} pending request(s) require your attention.`,
      'Call mcp__bukowski__get_pending_messages now to handle them before continuing your task.',
      previews
    ].filter(Boolean).join('\n');

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: text
      }
    }));
    quietExit();
  } catch {
    quietExit();
  }
});
