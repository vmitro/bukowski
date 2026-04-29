#!/usr/bin/env node
// UserPromptSubmit hook for Claude Code agents launched by bukowski.
//
// On each user prompt submit, peek the bukowski FIPA queue for this agent and,
// if any messages are pending, emit them as additionalContext so the agent sees
// them in-band instead of relying on PTY-injected text that the TUI can repaint.
//
// Identity comes from BUKOWSKI_AGENT_ID; transport is the same JSON-RPC unix
// socket the MCP bridge uses (BUKOWSKI_MCP_SOCKET). The peek is non-consuming —
// the agent still drains the queue via mcp__bukowski__get_pending_messages.
//
// Quietly no-ops when not running under bukowski, when env is missing, or on
// any error. We never want to break the user's prompt submission.

'use strict';

const net = require('net');
const fs = require('fs');

const HOOK_TIMEOUT_MS = parseInt(process.env.BUKOWSKI_HOOK_TIMEOUT_MS, 10) || 800;

function quietExit() { process.exit(0); }

const agentId = process.env.BUKOWSKI_AGENT_ID;
const socketPath = process.env.BUKOWSKI_MCP_SOCKET;
if (!agentId || !socketPath) quietExit();
try { if (!fs.existsSync(socketPath)) quietExit(); } catch { quietExit(); }

// Drain stdin without blocking. Claude Code passes hook event JSON; we don't
// need it but must not leave the pipe full.
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
    const peek = await rpc('bukowski/peek_messages', { agentId });
    sock.end();
    clearTimeout(overall);

    const count = peek?.count || 0;
    if (count <= 0) quietExit();

    const previews = (peek.previews || []).map((p) => {
      const sender = p.sender || 'unknown';
      const perf = p.performative || 'inform';
      const excerpt = (p.excerpt || '').replace(/\s+/g, ' ');
      return `  - [${perf}] from ${sender}: ${excerpt}`;
    }).join('\n');

    const context = [
      `[bukowski FIPA] ${count} pending message(s) in your inbox.`,
      'Call mcp__bukowski__get_pending_messages to retrieve and process them before continuing.',
      previews,
    ].filter(Boolean).join('\n');

    process.stdout.write(context + '\n');
    quietExit();
  } catch {
    quietExit();
  }
});
