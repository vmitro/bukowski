// src/handlers/chat/chatHandlers.js - Chat mode action handlers

const PERFORMATIVES = ['inform', 'request', 'query-if', 'query-ref', 'cfp', 'propose', 'agree', 'refuse', 'subscribe'];

const chatHandlers = {
  chat_char(ctx, result) {
    ctx.chatState.inputBuffer += result.char;
    ctx.compositor.draw();
  },

  chat_backspace(ctx, _result) {
    ctx.chatState.inputBuffer = ctx.chatState.inputBuffer.slice(0, -1);
    ctx.compositor.draw();
  },

  chat_delete_word(ctx, _result) {
    ctx.chatState.inputBuffer = ctx.chatState.inputBuffer.replace(/\S*\s*$/, '');
    ctx.compositor.draw();
  },

  chat_clear(ctx, _result) {
    ctx.chatState.inputBuffer = '';
    ctx.compositor.draw();
  },

  chat_exit(ctx, _result) {
    ctx.chatState.inputBuffer = '';
    ctx.chatState.selectedAgent = null;
    ctx.inputRouter.setMode('insert');
    ctx.compositor.draw();
  },

  chat_cycle_agent(ctx, _result) {
    const agents = ctx.session.getAllAgents();
    if (agents.length === 0) return;

    const currentIdx = ctx.chatState.selectedAgent
      ? agents.findIndex(a => a.id === ctx.chatState.selectedAgent)
      : -1;
    const nextIdx = (currentIdx + 1) % agents.length;
    ctx.chatState.selectedAgent = agents[nextIdx].id;
    ctx.compositor.draw();
  },

  chat_cycle_agent_back(ctx, _result) {
    const agents = ctx.session.getAllAgents();
    if (agents.length === 0) return;

    const currentIdx = ctx.chatState.selectedAgent
      ? agents.findIndex(a => a.id === ctx.chatState.selectedAgent)
      : 0;
    const prevIdx = currentIdx <= 0 ? agents.length - 1 : currentIdx - 1;
    ctx.chatState.selectedAgent = agents[prevIdx].id;
    ctx.compositor.draw();
  },

  chat_cycle_performative(ctx, _result) {
    const currentIdx = PERFORMATIVES.indexOf(ctx.chatState.pendingPerformative);
    const nextIdx = (currentIdx + 1) % PERFORMATIVES.length;
    ctx.chatState.pendingPerformative = PERFORMATIVES[nextIdx];
    ctx.compositor.draw();
  },

  chat_scroll_up(ctx, _result) {
    ctx.chatPane?.scrollUp(3);
    ctx.compositor.draw();
  },

  chat_scroll_down(ctx, _result) {
    ctx.chatPane?.scrollDown(3);
    ctx.compositor.draw();
  },

  chat_prev_conversation(ctx, _result) {
    ctx.chatPane?.prevConversation();
    ctx.compositor.draw();
  },

  chat_next_conversation(ctx, _result) {
    ctx.chatPane?.nextConversation();
    ctx.compositor.draw();
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
      ctx.compositor.draw();
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
    ctx.compositor.draw();
  }
};

module.exports = { chatHandlers };
