/**
 * Layout focus handlers - pane navigation and focus
 */

const focusHandlers = {
  focus_direction(ctx, result) {
    ctx.layoutManager.focusDirection(result.dir);
  },

  focus_next(ctx, _result) {
    ctx.layoutManager.cycleFocus(true);
    if (ctx.layoutManager.isZoomed()) ctx.onHandleResize();
  },

  focus_prev(ctx, _result) {
    ctx.layoutManager.cycleFocus(false);
    if (ctx.layoutManager.isZoomed()) ctx.onHandleResize();
  },

  focus_chat(ctx, _result) {
    ctx.onFocusOrCreateChatPane();
  }
};

module.exports = { focusHandlers };
