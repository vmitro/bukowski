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
  },

  // z-prefixed scroll alignment: cursor stays put, viewport moves so the
  // cursor's line lands at the requested position within the pane.
  scroll_align_top(ctx, _result) {
    const pane = ctx.getFocusedPane();
    if (!pane) return;
    const cursor = pickCursor(ctx);
    ctx.compositor.scrollOffsets.set(pane.id, Math.max(0, cursor.line));
    ctx.compositor.followTail.set(pane.id, false);
  },

  scroll_align_middle(ctx, _result) {
    const pane = ctx.getFocusedPane();
    if (!pane) return;
    const cursor = pickCursor(ctx);
    const target = cursor.line - Math.floor(pane.bounds.height / 2);
    ctx.compositor.scrollOffsets.set(pane.id, Math.max(0, target));
    ctx.compositor.followTail.set(pane.id, false);
  },

  scroll_align_bottom(ctx, _result) {
    const pane = ctx.getFocusedPane();
    if (!pane) return;
    const cursor = pickCursor(ctx);
    const target = cursor.line - pane.bounds.height + 1;
    ctx.compositor.scrollOffsets.set(pane.id, Math.max(0, target));
    ctx.compositor.followTail.set(pane.id, false);
  }
};

// Pick which cursor to align the viewport against based on current mode —
// visual modes use the moving cursor, normal mode uses the virtual cursor.
function pickCursor(ctx) {
  const m = ctx.vimState.mode;
  if (m === 'visual' || m === 'vline' || m === 'vblock') return ctx.vimState.visualCursor;
  return ctx.vimState.normalCursor;
}

module.exports = { scrollHandlers };
