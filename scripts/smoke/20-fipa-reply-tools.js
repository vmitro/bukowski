#!/usr/bin/env node
// Regression: a reply must carry its words and land on the thread it answers.
//
// Reported live by claude-meddaemon-1 (2026-09-26) after an acceptance reached
// its peer as an empty message on an unrelated thread — the peer read it as
// silence and a forward-port nearly sat unowned for a second session.
//
//   (a) fipa_agree passed a hardcoded null content and declared no `content`
//       property at all, so an agree could never carry text. FIPAHub.agree has
//       always taken optional confirmation content; only the MCP layer withheld
//       it — and multi.js had grown a comment calling null content "legitimate
//       (e.g. fipa_agree)", accommodating the symptom.
//   (b) An argument passed as `conversation_id` was silently dropped (schemas
//       are camelCase), so _sendFipaMessage saw none and minted a fresh
//       conversation: every reply opened a new thread.
//   (c) inReplyTo was accepted by callers and forwarded by nobody.
//
// Pure/fast: drives MCPServer._handleToolCall against a recording FIPAHub.

const path = require('path');
const { MCPServer } = require(path.join(__dirname, '..', '..', 'src', 'mcp', 'MCPServer'));

let failed = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${msg}`);
  if (!cond) failed++;
};

function server() {
  const s = Object.create(MCPServer.prototype);
  s.sent = [];
  const rec = (performative) => (from, to, content, opts) => {
    s.sent.push({ performative, from, to, content, opts });
  };
  s.fipaHub = {
    request: rec('request'), inform: rec('inform'), agree: rec('agree'),
    refuse: rec('refuse'), propose: rec('propose'),
    queryIf: rec('query-if'), queryRef: rec('query-ref'),
  };
  s.session = { getAgent: (id) => (id === 'claude-azra-2' ? { id } : null), getAllAgents: () => [] };
  s.externalAgents = new Map();
  s.federationHub = null;
  return s;
}
const call = async (s, tool, args) => s._handleToolCall(tool, args, 'claude-meddaemon-1');
const last = (s) => s.sent[s.sent.length - 1];

(async () => {
  const CONV = 'cad8e164-2ea5-4919-82dc-7dc7c923f6c9';

  // ── 1. An agree carries its words ────────────────────────────────────────
  {
    const s = server();
    await call(s, 'fipa_agree', { to: 'claude-azra-2', conversationId: CONV, content: 'taking the forward-port' });
    ok(last(s).performative === 'agree', 'fipa_agree sends an agree');
    ok(last(s).content === 'taking the forward-port', 'the agree carries the content it was given');
    ok(last(s).opts.conversationId === CONV, 'and lands on the conversation it answers');
  }

  // ── 2. A bare agree still works, and an agree to no thread is refused ────
  {
    const s = server();
    await call(s, 'fipa_agree', { to: 'claude-azra-2', conversationId: CONV });
    ok(last(s).content === null, 'content stays optional');

    let err = null;
    try { await call(s, 'fipa_agree', { to: 'claude-azra-2', content: 'yes' }); }
    catch (e) { err = e; }
    ok(err && /conversationId/.test(err.message),
      'an agree with no conversation is refused, not silently given a new one');
    ok(s.sent.length === 1, 'and nothing was sent');
  }

  // ── 3. snake_case argument names are honoured, not dropped ───────────────
  {
    const s = server();
    // Verbatim the shape from the report.
    await call(s, 'fipa_agree', {
      to: 'claude-azra-2', conversation_id: CONV, in_reply_to: 'msg-7', content: 'ack',
    });
    ok(last(s).opts.conversationId === CONV, 'conversation_id threads onto the same conversation');
    ok(last(s).opts.inReplyTo === 'msg-7', 'in_reply_to is forwarded as inReplyTo');
    ok(last(s).content === 'ack', 'and the content survives');

    await call(s, 'fipa_inform', { to: 'claude-azra-2', conversation_id: CONV, content: 'detail' });
    ok(last(s).opts.conversationId === CONV, 'fipa_inform threads on conversation_id too');
  }

  // ── 4. camelCase wins when both spellings are present ────────────────────
  {
    const s = server();
    await call(s, 'fipa_inform', {
      to: 'claude-azra-2', conversationId: CONV, conversation_id: 'other', content: 'x',
    });
    ok(last(s).opts.conversationId === CONV, 'the canonical spelling takes precedence');
  }

  // ── 5. A send with no conversation still gets one minted ─────────────────
  {
    const s = server();
    const r = await call(s, 'fipa_inform', { to: 'claude-azra-2', content: 'cold open' });
    ok(typeof r.conversationId === 'string' && r.conversationId.length > 0,
      'an opening inform mints a conversation and returns it');
    ok(last(s).opts.inReplyTo === undefined, 'and carries no inReplyTo when none was given');
  }

  // ── 6. Every reply-capable performative threads ──────────────────────────
  {
    const s = server();
    const shapes = [
      ['fipa_request', { action: 'do it' }],
      ['fipa_inform', { content: 'fyi' }],
      ['fipa_query_if', { proposition: 'is it done' }],
      ['fipa_query_ref', { reference: 'the sha' }],
      ['fipa_propose', { proposal: 'plan b' }],
      ['fipa_refuse', { reason: 'busy' }],
    ];
    for (const [tool, extra] of shapes) {
      await call(s, tool, { to: 'claude-azra-2', conversation_id: CONV, in_reply_to: 'msg-7', ...extra });
      ok(last(s).opts.conversationId === CONV && last(s).opts.inReplyTo === 'msg-7',
        `${tool} threads on both conversation_id and in_reply_to`);
    }
  }

  if (failed > 0) {
    console.log(`${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log('fipa-reply-tools OK');
})();
