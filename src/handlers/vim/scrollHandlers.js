/**
 * Vim scroll handlers
 */

const scrollHandlers = {
  scroll_down(ctx, result) {
    ctx.compositor.scrollFocused(result.count || 1);
  },

  scroll_up(ctx, result) {
    ctx.compositor.scrollFocused(-(result.count || 1));
  },

  scroll_half_down(ctx, _result) {
    const pane = ctx.getFocusedPane();
    ctx.compositor.scrollFocused(Math.floor((pane?.bounds.height || 12) / 2));
  },

  scroll_half_up(ctx, _result) {
    const pane = ctx.getFocusedPane();
    ctx.compositor.scrollFocused(-Math.floor((pane?.bounds.height || 12) / 2));
  },

  scroll_page_down(ctx, _result) {
    const pane = ctx.getFocusedPane();
    ctx.compositor.scrollFocused(pane?.bounds.height || 24);
  },

  scroll_page_up(ctx, _result) {
    const pane = ctx.getFocusedPane();
    ctx.compositor.scrollFocused(-(pane?.bounds.height || 24));
  },

  scroll_to_bottom(ctx, _result) {
    ctx.compositor.scrollFocusedTo('bottom');
    const agent = ctx.getFocusedAgent();
    if (agent) {
      ctx.vimState.normalCursor.line = agent.getContentHeight() - 1;
      ctx.vimState.normalCursor.col = 0;
    }
  },

  scroll_to_top(ctx, _result) {
    ctx.compositor.scrollFocusedTo('top');
    ctx.vimState.normalCursor.line = 0;
    ctx.vimState.normalCursor.col = 0;
  }
};

module.exports = { scrollHandlers };
