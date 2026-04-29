#!/usr/bin/env node
// Stop hook for Claude Code agents launched by bukowski.
//
// When Claude tries to end a turn, peek the bukowski FIPA queue. If anything
// is pending, block the stop and pass the count + previews as the `reason`,
// which Claude Code surfaces as continuation context — the agent then drains
// the queue via mcp__bukowski__get_pending_messages on the next turn.
//
// Companion to userprompt-submit.js: that hook covers messages that arrived
// before the turn (visible at submit), this one covers messages that arrived
// during the turn (only visible at turn end).
//
// Loop safety: Claude Code passes `stop_hook_active: true` in the event JSON
// when the current stop is itself a continuation triggered by a prior block.
// We respect that and never block twice in a row — the agent gets one extra
// turn to drain, and if the queue is still populated after that, allow stop
// to avoid a runaway loop.

'use strict';

const net = require('net');
const fs = require('fs');

const HOOK_TIMEOUT_MS = parseInt(process.env.BUKOWSKI_HOOK_TIMEOUT_MS, 10) || 800;
const STDIN_WAIT_MS = 100;

function quietExit() { process.exit(0); }

const agentId = process.env.BUKOWSKI_AGENT_ID;
const socketPath = process.env.BUKOWSKI_MCP_SOCKET;
if (!agentId || !socketPath) quietExit();
try { if (!fs.existsSync(socketPath)) quietExit(); } catch { quietExit(); }

// Read the Stop event JSON from stdin so we can honour `stop_hook_active`.
const stdinChunks = [];
let started = false;
process.stdin.on('data', (c) => stdinChunks.push(c));
process.stdin.on('end', start);
process.stdin.on('error', () => {});
setTimeout(start, STDIN_WAIT_MS);

function start() {
  if (started) return;
  started = true;
  let event = {};
  try {
    const raw = Buffer.concat(stdinChunks).toString('utf8');
    if (raw.trim()) event = JSON.parse(raw);
  } catch { /* ignore parse errors */ }

  // Already in a continuation triggered by a prior block — don't block again.
  if (event && event.stop_hook_active) quietExit();

  doPeek();
}

function doPeek() {
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

      const reason = [
        `${count} FIPA message(s) pending in your bukowski inbox.`,
        'Call mcp__bukowski__get_pending_messages to retrieve and process them before stopping.',
        previews
      ].filter(Boolean).join('\n');

      process.stdout.write(JSON.stringify({ decision: 'block', reason }));
      quietExit();
    } catch {
      quietExit();
    }
  });
}
