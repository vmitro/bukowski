// src/handlers/chat/chatHandlers.js - Chat mode action handlers

const PERFORMATIVES = ['inform', 'request', 'query-if', 'query-ref', 'cfp', 'propose', 'agree', 'refuse', 'subscribe'];

const chatHandlers = {
  chat_char(ctx, result) {
    const buf = ctx.chatState.inputBuffer;
    const pos = ctx.chatState.cursorPos;
    ctx.chatState.inputBuffer = buf.slice(0, pos) + result.char + buf.slice(pos);
    ctx.chatState.cursorPos = pos + result.char.length;
    ctx.compositor.scheduleDraw();
  },

  chat_backspace(ctx, _result) {
    const buf = ctx.chatState.inputBuffer;
    const pos = ctx.chatState.cursorPos;
    if (pos > 0) {
      ctx.chatState.inputBuffer = buf.slice(0, pos - 1) + buf.slice(pos);
      ctx.chatState.cursorPos = pos - 1;
    }
    ctx.compositor.scheduleDraw();
  },

  chat_delete(ctx, _result) {
    const buf = ctx.chatState.inputBuffer;
    const pos = ctx.chatState.cursorPos;
    if (pos < buf.length) {
      ctx.chatState.inputBuffer = buf.slice(0, pos) + buf.slice(pos + 1);
    }
    ctx.compositor.scheduleDraw();
  },

  chat_delete_word(ctx, _result) {
    const buf = ctx.chatState.inputBuffer;
    const pos = ctx.chatState.cursorPos;
    // Delete word before cursor (like Ctrl+W)
    const before = buf.slice(0, pos);
    const after = buf.slice(pos);
    const newBefore = before.replace(/\S*\s*$/, '');
    ctx.chatState.inputBuffer = newBefore + after;
    ctx.chatState.cursorPos = newBefore.length;
    ctx.compositor.scheduleDraw();
  },

  chat_newline(ctx, _result) {
    const buf = ctx.chatState.inputBuffer;
    const pos = ctx.chatState.cursorPos;
    ctx.chatState.inputBuffer = buf.slice(0, pos) + '\n' + buf.slice(pos);
    ctx.chatState.cursorPos = pos + 1;
    ctx.compositor.scheduleDraw();
  },

  chat_clear(ctx, _result) {
    ctx.chatState.inputBuffer = '';
    ctx.chatState.cursorPos = 0;
    ctx.compositor.scheduleDraw();
  },

  chat_exit(ctx, _result) {
    ctx.chatState.inputBuffer = '';
    ctx.chatState.cursorPos = 0;
    ctx.chatState.selectedAgent = null;
    ctx.inputRouter.setMode('insert');
    ctx.compositor.scheduleDraw();
  },

  chat_cursor_left(ctx, _result) {
    if (ctx.chatState.cursorPos > 0) {
      ctx.chatState.cursorPos--;
    }
    ctx.compositor.scheduleDraw();
  },

  chat_cursor_right(ctx, _result) {
    if (ctx.chatState.cursorPos < ctx.chatState.inputBuffer.length) {
      ctx.chatState.cursorPos++;
    }
    ctx.compositor.scheduleDraw();
  },

  chat_cursor_home(ctx, _result) {
    ctx.chatState.cursorPos = 0;
    ctx.compositor.scheduleDraw();
  },

  chat_cursor_end(ctx, _result) {
    ctx.chatState.cursorPos = ctx.chatState.inputBuffer.length;
    ctx.compositor.scheduleDraw();
  },

  chat_word_left(ctx, _result) {
    const buf = ctx.chatState.inputBuffer;
    let pos = ctx.chatState.cursorPos;
    // Skip whitespace, then skip word chars
    while (pos > 0 && /\s/.test(buf[pos - 1])) pos--;
    while (pos > 0 && /\S/.test(buf[pos - 1])) pos--;
    ctx.chatState.cursorPos = pos;
    ctx.compositor.scheduleDraw();
  },

  chat_word_right(ctx, _result) {
    const buf = ctx.chatState.inputBuffer;
    let pos = ctx.chatState.cursorPos;
    // Skip word chars, then skip whitespace
    while (pos < buf.length && /\S/.test(buf[pos])) pos++;
    while (pos < buf.length && /\s/.test(buf[pos])) pos++;
    ctx.chatState.cursorPos = pos;
    ctx.compositor.scheduleDraw();
  },

  chat_paste(ctx, result) {
    const buf = ctx.chatState.inputBuffer;
    const pos = ctx.chatState.cursorPos;
    const text = result.text || '';
    // Insert pasted text at cursor, normalize CRLF to LF
    const clean = text.replace(/\r\n/g, '\n');
    ctx.chatState.inputBuffer = buf.slice(0, pos) + clean + buf.slice(pos);
    ctx.chatState.cursorPos = pos + clean.length;
    ctx.compositor.scheduleDraw();
  },

  chat_chunk(ctx, result) {
    const buf = ctx.chatState.inputBuffer;
    const pos = ctx.chatState.cursorPos;
    const text = result.text || '';
    // Insert chunk at cursor, normalize control/newlines to spaces
    const clean = text
      .replace(/\r\n/g, '\n')
      .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
    if (!clean) return;
    ctx.chatState.inputBuffer = buf.slice(0, pos) + clean + buf.slice(pos);
    ctx.chatState.cursorPos = pos + clean.length;
    ctx.compositor.scheduleDraw();
  },

  chat_cycle_agent(ctx, _result) {
    const agents = ctx.session.getAllAgents();
    if (agents.length === 0) return;

    const currentIdx = ctx.chatState.selectedAgent
      ? agents.findIndex(a => a.id === ctx.chatState.selectedAgent)
      : -1;
    const nextIdx = (currentIdx + 1) % agents.length;
    ctx.chatState.selectedAgent = agents[nextIdx].id;
    ctx.compositor.scheduleDraw();
  },

  chat_cycle_agent_back(ctx, _result) {
    const agents = ctx.session.getAllAgents();
    if (agents.length === 0) return;

    const currentIdx = ctx.chatState.selectedAgent
      ? agents.findIndex(a => a.id === ctx.chatState.selectedAgent)
      : 0;
    const prevIdx = currentIdx <= 0 ? agents.length - 1 : currentIdx - 1;
    ctx.chatState.selectedAgent = agents[prevIdx].id;
    ctx.compositor.scheduleDraw();
  },

  chat_cycle_performative(ctx, _result) {
    const currentIdx = PERFORMATIVES.indexOf(ctx.chatState.pendingPerformative);
    const nextIdx = (currentIdx + 1) % PERFORMATIVES.length;
    ctx.chatState.pendingPerformative = PERFORMATIVES[nextIdx];
    ctx.compositor.scheduleDraw();
  },

  chat_cycle_performative_back(ctx, _result) {
    const currentIdx = PERFORMATIVES.indexOf(ctx.chatState.pendingPerformative);
    const prevIdx = currentIdx <= 0 ? PERFORMATIVES.length - 1 : currentIdx - 1;
    ctx.chatState.pendingPerformative = PERFORMATIVES[prevIdx];
    ctx.compositor.scheduleDraw();
  },

  chat_scroll_up(ctx, _result) {
    ctx.chatPane?.scrollUp(3);
    ctx.compositor.scheduleDraw();
  },

  chat_scroll_down(ctx, _result) {
    ctx.chatPane?.scrollDown(3);
    ctx.compositor.scheduleDraw();
  },

  chat_prev_conversation(ctx, _result) {
    ctx.chatPane?.prevConversation();
    ctx.compositor.scheduleDraw();
  },

  chat_next_conversation(ctx, _result) {
    ctx.chatPane?.nextConversation();
    ctx.compositor.scheduleDraw();
  },

  chat_send(ctx, _result) {
    // Send FIPA message from focused agent to selected agent
    const fromAgent = ctx.getFocusedAgent();
    const toAgentId = ctx.chatState.selectedAgent;
    const content = ctx.chatState.inputBuffer.trim();

    if (!fromAgent || !toAgentId || !content) {
      // Need to select target agent first
      if (!toAgentId) {
        ctx.chatState.showAgentPicker = true;
      }
      ctx.compositor.scheduleDraw();
      return;
    }

    // Get the target agent
    const toAgent = ctx.session.getAgent(toAgentId);
    if (!toAgent) return;

    // Send via FIPAHub based on performative
    const perf = ctx.chatState.pendingPerformative;
    switch (perf) {
      case 'request':
        ctx.fipaHub.request(fromAgent.id, toAgent.id, content);
        break;
      case 'inform':
        ctx.fipaHub.inform(fromAgent.id, toAgent.id, content);
        break;
      case 'query-if':
        ctx.fipaHub.queryIf(fromAgent.id, toAgent.id, content);
        break;
      case 'query-ref':
        ctx.fipaHub.queryRef(fromAgent.id, toAgent.id, content);
        break;
      case 'cfp': {
        // CFP broadcasts to all agents except sender
        const otherAgents = ctx.session.getAllAgents()
          .filter(a => a.id !== fromAgent.id)
          .map(a => a.id);
        ctx.fipaHub.cfp(fromAgent.id, otherAgents, { task: content });
        break;
      }
      case 'subscribe':
        ctx.fipaHub.subscribe(fromAgent.id, toAgent.id, { topic: content });
        break;
      default:
        // For propose, agree, refuse - use inform as fallback
        ctx.fipaHub.inform(fromAgent.id, toAgent.id, { [perf]: content });
    }

    // Clear input after sending
    ctx.chatState.inputBuffer = '';
    ctx.chatState.cursorPos = 0;
    ctx.compositor.scheduleDraw();
  }
};

module.exports = { chatHandlers };
