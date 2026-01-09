// src/handlers/acl/aclHandlers.js - ACL send mode action handlers

const { extractSelectedText } = require('../../utils/bufferText');

const PERFORMATIVES = ['inform', 'request', 'query-if', 'query-ref', 'cfp', 'propose', 'agree', 'refuse', 'subscribe'];

const aclHandlers = {
  acl_send_start(ctx, result) {
    const focusedAgent = ctx.getFocusedAgent();

    // Extract selected text if in visual mode
    let text = '';
    if (ctx.vimState.mode === 'visual' || ctx.vimState.mode === 'vline') {
      text = extractSelectedText(focusedAgent, ctx.vimState);
    }

    ctx.aclState.active = true;
    ctx.aclState.selectedText = text;
    ctx.aclState.sourceAgent = focusedAgent?.id || null;
    ctx.aclState.performative = result.performative || 'inform';

    // Get terminal dimensions for centering
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const overlayWidth = Math.min(60, cols - 10);
    const overlayHeight = Math.min(12, rows - 6);

    // Show ACL input overlay centered on screen
    const overlay = ctx.overlayManager.show({
      id: 'acl-input',
      type: 'acl-input',
      x: Math.floor((cols - overlayWidth) / 2),
      y: Math.floor((rows - overlayHeight) / 2),
      width: overlayWidth,
      height: overlayHeight,
      performative: ctx.aclState.performative,
      sourceAgent: focusedAgent?.id,
      targetAgent: ctx.aclState.targetAgent,
      content: text,
      agents: ctx.session.getAllAgents().map(a => ({ id: a.id, name: a.name, type: a.type }))
    });

    ctx.aclState.overlayId = overlay.id;
    ctx.inputRouter.setMode('acl-send');
    ctx.vimState.mode = 'insert';  // Exit visual mode
    ctx.compositor.draw();
  },

  acl_target_direction(ctx, result) {
    // Find agent in that direction
    const targetPane = ctx.layoutManager.findPaneInDirection(result.dir);
    if (targetPane) {
      const agent = ctx.session.getAgent(targetPane.agentId);
      if (agent) {
        ctx.aclState.targetAgent = agent.id;

        // Update overlay
        const overlay = ctx.overlayManager.get(ctx.aclState.overlayId);
        if (overlay) {
          overlay.setTarget(agent.id);
        }
        ctx.compositor.draw();
      }
    } else {
      // No pane in that direction -> show agent picker
      const overlay = ctx.overlayManager.get(ctx.aclState.overlayId);
      if (overlay && overlay.showAgentPicker) {
        overlay.showAgentPicker(ctx.session.getAllAgents().map(a => ({
          id: a.id,
          name: a.name,
          type: a.type
        })));
        ctx.aclState.agentPickerActive = true;
        ctx.compositor.draw();
      }
    }
  },

  acl_cycle_agent(ctx, _result) {
    const agents = ctx.session.getAllAgents().filter(a => a.id !== ctx.aclState.sourceAgent);
    if (agents.length === 0) return;

    const currentIdx = ctx.aclState.targetAgent
      ? agents.findIndex(a => a.id === ctx.aclState.targetAgent)
      : -1;
    const nextIdx = (currentIdx + 1) % agents.length;
    ctx.aclState.targetAgent = agents[nextIdx].id;

    // Update overlay
    const overlay = ctx.overlayManager.get(ctx.aclState.overlayId);
    if (overlay) {
      overlay.setTarget(ctx.aclState.targetAgent);
    }
    ctx.compositor.draw();
  },

  acl_cycle_agent_back(ctx, _result) {
    const agents = ctx.session.getAllAgents().filter(a => a.id !== ctx.aclState.sourceAgent);
    if (agents.length === 0) return;

    const currentIdx = ctx.aclState.targetAgent
      ? agents.findIndex(a => a.id === ctx.aclState.targetAgent)
      : 0;
    const prevIdx = currentIdx <= 0 ? agents.length - 1 : currentIdx - 1;
    ctx.aclState.targetAgent = agents[prevIdx].id;

    // Update overlay
    const overlay = ctx.overlayManager.get(ctx.aclState.overlayId);
    if (overlay) {
      overlay.setTarget(ctx.aclState.targetAgent);
    }
    ctx.compositor.draw();
  },

  acl_cycle_performative(ctx, _result) {
    const currentIdx = PERFORMATIVES.indexOf(ctx.aclState.performative);
    const nextIdx = (currentIdx + 1) % PERFORMATIVES.length;
    ctx.aclState.performative = PERFORMATIVES[nextIdx];

    // Update overlay
    const overlay = ctx.overlayManager.get(ctx.aclState.overlayId);
    if (overlay) {
      overlay.setPerformative(ctx.aclState.performative);
    }
    ctx.compositor.draw();
  },

  acl_cycle_performative_back(ctx, _result) {
    const currentIdx = PERFORMATIVES.indexOf(ctx.aclState.performative);
    const prevIdx = currentIdx <= 0 ? PERFORMATIVES.length - 1 : currentIdx - 1;
    ctx.aclState.performative = PERFORMATIVES[prevIdx];

    // Update overlay
    const overlay = ctx.overlayManager.get(ctx.aclState.overlayId);
    if (overlay) {
      overlay.setPerformative(ctx.aclState.performative);
    }
    ctx.compositor.draw();
  },

  acl_send(ctx, _result) {
    const overlay = ctx.overlayManager.get(ctx.aclState.overlayId);
    if (!overlay) return;

    if (!ctx.aclState.targetAgent) {
      // Need to select target agent first - show picker
      if (overlay.showAgentPicker) {
        overlay.showAgentPicker(ctx.session.getAllAgents().map(a => ({
          id: a.id,
          name: a.name,
          type: a.type
        })));
        ctx.aclState.agentPickerActive = true;
      }
      ctx.compositor.draw();
      return;
    }

    const content = overlay.inputBuffer;
    if (!content.trim()) {
      ctx.compositor.draw();
      return;
    }

    // Get the target agent
    const toAgent = ctx.session.getAgent(ctx.aclState.targetAgent);
    if (!toAgent) return;

    // Send via FIPAHub based on performative
    const perf = ctx.aclState.performative;
    const fromId = ctx.aclState.sourceAgent;

    switch (perf) {
      case 'request':
        ctx.fipaHub.request(fromId, toAgent.id, content);
        break;
      case 'inform':
        ctx.fipaHub.inform(fromId, toAgent.id, content);
        break;
      case 'query-if':
        ctx.fipaHub.queryIf(fromId, toAgent.id, content);
        break;
      case 'query-ref':
        ctx.fipaHub.queryRef(fromId, toAgent.id, content);
        break;
      case 'cfp': {
        // CFP broadcasts to all agents except sender
        const otherAgents = ctx.session.getAllAgents()
          .filter(a => a.id !== fromId)
          .map(a => a.id);
        ctx.fipaHub.cfp(fromId, otherAgents, { task: content });
        break;
      }
      case 'subscribe':
        ctx.fipaHub.subscribe(fromId, toAgent.id, { topic: content });
        break;
      default:
        // For propose, agree, refuse - use inform as fallback
        ctx.fipaHub.inform(fromId, toAgent.id, { [perf]: content });
    }

    // Cleanup
    ctx.overlayManager.hide(ctx.aclState.overlayId);
    ctx.aclState.active = false;
    ctx.aclState.overlayId = null;
    ctx.aclState.targetAgent = null;
    ctx.aclState.selectedText = '';
    ctx.inputRouter.setMode('insert');
    ctx.compositor.draw();
  },

  acl_cancel(ctx, _result) {
    // Close overlay without sending
    if (ctx.aclState.overlayId) {
      ctx.overlayManager.hide(ctx.aclState.overlayId);
    }
    ctx.aclState.active = false;
    ctx.aclState.overlayId = null;
    ctx.aclState.targetAgent = null;
    ctx.aclState.selectedText = '';
    ctx.aclState.agentPickerActive = false;
    ctx.compositor.draw();
  },

  acl_char(ctx, result) {
    const overlay = ctx.overlayManager.get(ctx.aclState.overlayId);
    if (overlay) {
      overlay.addChar(result.char);
      ctx.compositor.draw();
    }
  },

  acl_backspace(ctx, _result) {
    const overlay = ctx.overlayManager.get(ctx.aclState.overlayId);
    if (overlay) {
      overlay.backspace();
      ctx.compositor.draw();
    }
  },

  acl_delete_word(ctx, _result) {
    const overlay = ctx.overlayManager.get(ctx.aclState.overlayId);
    if (overlay) {
      overlay.deleteWord();
      ctx.compositor.draw();
    }
  },

  acl_clear(ctx, _result) {
    const overlay = ctx.overlayManager.get(ctx.aclState.overlayId);
    if (overlay) {
      overlay.clear();
      ctx.compositor.draw();
    }
  },

  acl_cursor_left(ctx, _result) {
    const overlay = ctx.overlayManager.get(ctx.aclState.overlayId);
    if (overlay) {
      overlay.cursorLeft();
      ctx.compositor.draw();
    }
  },

  acl_cursor_right(ctx, _result) {
    const overlay = ctx.overlayManager.get(ctx.aclState.overlayId);
    if (overlay) {
      overlay.cursorRight();
      ctx.compositor.draw();
    }
  },

  acl_need_target(ctx, _result) {
    // Show agent picker overlay
    const overlay = ctx.overlayManager.get(ctx.aclState.overlayId);
    if (overlay && overlay.showAgentPicker) {
      overlay.showAgentPicker(ctx.session.getAllAgents().map(a => ({
        id: a.id,
        name: a.name,
        type: a.type
      })));
      ctx.aclState.agentPickerActive = true;
      ctx.compositor.draw();
    }
  }
};

module.exports = { aclHandlers };
