// src/handlers/fipa/fipaHandlers.js - FIPA performative action handlers

const PERFORMATIVE_MAP = {
  'fipa_request': 'request',
  'fipa_inform': 'inform',
  'fipa_query_if': 'query-if',
  'fipa_query_ref': 'query-ref',
  'fipa_cfp': 'cfp',
  'fipa_propose': 'propose',
  'fipa_agree': 'agree',
  'fipa_refuse': 'refuse',
  'fipa_subscribe': 'subscribe'
};

function handleFipaAction(ctx, result) {
  const performative = PERFORMATIVE_MAP[result.action] || 'inform';

  // Find or create chat pane
  const chatPanes = ctx.layoutManager.getAllPanes().filter(p => p.agentId.startsWith('chat-'));
  if (chatPanes.length > 0) {
    // Focus existing chat pane and set performative
    ctx.layoutManager.focusPane(chatPanes[chatPanes.length - 1].id);
    const chatAgent = ctx.session.getAgent(chatPanes[chatPanes.length - 1].agentId);
    if (chatAgent) chatAgent.performative = performative;
  } else {
    // Create new chat pane with this performative
    ctx.onShowConversationPicker('horizontal');
    // Store performative to apply after pane creation
    ctx.chatState.pendingPerformative = performative;
  }
  ctx.compositor.draw();
}

const fipaHandlers = {
  fipa_request: handleFipaAction,
  fipa_inform: handleFipaAction,
  fipa_query_if: handleFipaAction,
  fipa_query_ref: handleFipaAction,
  fipa_cfp: handleFipaAction,
  fipa_propose: handleFipaAction,
  fipa_agree: handleFipaAction,
  fipa_refuse: handleFipaAction,
  fipa_subscribe: handleFipaAction
};

module.exports = { fipaHandlers };
