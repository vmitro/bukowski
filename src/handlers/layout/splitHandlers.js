/**
 * Layout split and pane management handlers
 */

const splitHandlers = {
  split_horizontal(ctx, result) {
    const agentType = result.agentType || 'claude';
    const extraArgs = result.extraArgs || [];

    // Splitting while zoomed would operate on the detached single-pane zoom
    // view (the real tree lives in savedLayout), orphaning the new pane —
    // it renders grayed and unreachable. Unzoom first, then split the real
    // layout.
    if (ctx.layoutManager.isZoomed()) ctx.layoutManager.toggleZoom();

    if (agentType === 'chat') {
      ctx.onShowConversationPicker('horizontal');
    } else if (agentType === 'dashboard') {
      ctx.onCreateDashboardPane('horizontal');
    } else {
      const newAgent = ctx.onCreateNewAgent(agentType, extraArgs);
      const newPane = ctx.layoutManager.splitHorizontal(newAgent.id);
      if (newPane) {
        newAgent.spawn(newPane.bounds.width, newPane.bounds.height);
        ctx.onSetupAgentHandlers(newAgent);
      }
      ctx.onHandleResize();
    }
  },

  split_vertical(ctx, result) {
    const agentType = result.agentType || 'claude';
    const extraArgs = result.extraArgs || [];

    // See split_horizontal: unzoom before splitting so the new pane lands in
    // the real layout instead of the throwaway zoom view.
    if (ctx.layoutManager.isZoomed()) ctx.layoutManager.toggleZoom();

    if (agentType === 'chat') {
      ctx.onShowConversationPicker('vertical');
    } else if (agentType === 'dashboard') {
      ctx.onCreateDashboardPane('vertical');
    } else {
      const newAgent = ctx.onCreateNewAgent(agentType, extraArgs);
      const newPane = ctx.layoutManager.splitVertical(newAgent.id);
      if (newPane) {
        newAgent.spawn(newPane.bounds.width, newPane.bounds.height);
        ctx.onSetupAgentHandlers(newAgent);
      }
      ctx.onHandleResize();
    }
  },

  close_pane(ctx, _result) {
    const paneToClose = ctx.layoutManager.getFocusedPane();
    if (paneToClose) {
      const paneId = paneToClose.id;
      const agentToKill = ctx.session.getAgent(paneToClose.agentId);
      if (ctx.layoutManager.closePane()) {
        ctx.compositor.cleanupPane(paneId);
        if (agentToKill) {
          if (typeof agentToKill.destroy === 'function') agentToKill.destroy();
          ctx.session.removeAgent(agentToKill.id);
        }
        ctx.onHandleResize();
      }
    }
  },

  close_others(ctx, _result) {
    ctx.layoutManager.closeOthers();
    ctx.onHandleResize();
  },

  new_tab(ctx, result) {
    const agentType = result.agentType || 'claude';
    const extraArgs = result.extraArgs || [];
    const newAgent = ctx.onCreateNewAgent(agentType, extraArgs);

    // Close all other panes and make this the only one
    ctx.layoutManager.closeOthers();

    // Replace the current pane's agent
    const currentPane = ctx.layoutManager.getFocusedPane();
    if (currentPane) {
      const oldAgent = ctx.session.getAgent(currentPane.agentId);
      if (oldAgent) {
        ctx.session.removeAgent(oldAgent.id);
      }
      currentPane.agentId = newAgent.id;
      newAgent.spawn(currentPane.bounds.width, currentPane.bounds.height);
      ctx.onSetupAgentHandlers(newAgent);
    }
    ctx.onHandleResize();
  },

  equalize(ctx, _result) {
    ctx.layoutManager.equalize();
    ctx.onHandleResize();
  },

  zoom_toggle(ctx, _result) {
    ctx.layoutManager.toggleZoom();
    ctx.onHandleResize();
  },

  resize(ctx, result) {
    ctx.layoutManager.resizeFocused(result.delta);
    ctx.onHandleResize();
  },

  switch_tab(ctx, result) {
    const panes = ctx.layoutManager.getAllPanes();
    if (result.index < panes.length) {
      ctx.layoutManager.focusPane(panes[result.index].id);
    }
  },

  prev_tab(ctx, _result) {
    ctx.layoutManager.cycleFocus(false);
  },

  next_tab(ctx, _result) {
    ctx.layoutManager.cycleFocus(true);
  }
};

module.exports = { splitHandlers };
