/**
 * Layout focus handlers - pane navigation and focus
 */

const focusHandlers = {
  focus_direction(ctx, result) {
    ctx.layoutManager.focusDirection(result.dir);
  },

  // A single-pane layout has nothing to cycle THROUGH, so these keys used to
  // die silently. The tab bar still lists every agent, so fall through to
  // cycling those — the one thing on screen the key can still act on.
  focus_next(ctx, _result) {
    if (!ctx.layoutManager.cycleFocus(true)) ctx.layoutManager.cycleAgent(true);
    if (ctx.layoutManager.isZoomed()) ctx.onHandleResize();
  },

  focus_prev(ctx, _result) {
    if (!ctx.layoutManager.cycleFocus(false)) ctx.layoutManager.cycleAgent(false);
    if (ctx.layoutManager.isZoomed()) ctx.onHandleResize();
  },

  focus_chat(ctx, _result) {
    ctx.onFocusOrCreateChatPane();
  }
};

module.exports = { focusHandlers };
