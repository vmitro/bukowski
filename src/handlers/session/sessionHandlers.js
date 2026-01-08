/**
 * Session management handlers - save, quit, passthrough
 */

const sessionHandlers = {
  save_session(ctx, _result) {
    ctx.session.save(undefined, ctx.fipaHub.conversations).then(_filepath => {
      // Flash message would go here
    }).catch(() => {});
  },

  quit_force(ctx, _result) {
    ctx.terminal.cleanup();
    if (ctx.ipcHub) ctx.ipcHub.stop();
    ctx.session.destroy();
    process.exit(0);
  },

  quit_confirm(ctx, _result) {
    // For now, just quit
    ctx.terminal.cleanup();
    if (ctx.ipcHub) ctx.ipcHub.stop();
    ctx.session.destroy();
    process.exit(0);
  },

  passthrough(ctx, _result) {
    // Already written to agent in InputRouter
    ctx.compositor.resetCursorBlink();
  }
};

module.exports = { sessionHandlers };
