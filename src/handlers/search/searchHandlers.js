/**
 * Search and command mode handlers
 */

const searchHandlers = {
  search_start(ctx, result) {
    ctx.searchState.previousMode = ctx.vimState.mode;
    ctx.searchState.active = true;
    ctx.searchState.pattern = '';
    ctx.searchState.direction = result.direction || 'forward';
  },

  search_char(ctx, result) {
    if (ctx.searchState.active) {
      ctx.searchState.pattern += result.char;
    }
  },

  search_backspace(ctx, _result) {
    if (ctx.searchState.active) {
      ctx.searchState.pattern = ctx.searchState.pattern.slice(0, -1);
    }
  },

  search_delete_word(ctx, _result) {
    if (ctx.searchState.active) {
      ctx.searchState.pattern = ctx.searchState.pattern.replace(/\S*\s*$/, '');
    }
  },

  search_clear(ctx, _result) {
    if (ctx.searchState.active) {
      ctx.searchState.pattern = '';
    }
  },

  search_confirm(ctx, _result) {
    ctx.searchState.active = false;
    ctx.onExecuteSearch();
    // If we were in visual mode, extend selection to match
    if ((ctx.searchState.previousMode === 'visual' || ctx.searchState.previousMode === 'vline') &&
        ctx.searchState.matches.length > 0) {
      const match = ctx.searchState.matches[ctx.searchState.index];
      ctx.vimState.mode = ctx.searchState.previousMode;
      ctx.vimState.visualCursor.line = match.line;
      ctx.vimState.visualCursor.col = match.col;
      ctx.ensureLineVisible(match.line);
    }
  },

  search_cancel(ctx, _result) {
    ctx.searchState.active = false;
    // Keep matches for highlighting
  },

  search_next(ctx, _result) {
    if (ctx.searchState.matches.length > 0) {
      ctx.searchState.index = (ctx.searchState.index + 1) % ctx.searchState.matches.length;
      ctx.onJumpToMatch();
    }
  },

  search_prev(ctx, _result) {
    if (ctx.searchState.matches.length > 0) {
      ctx.searchState.index = (ctx.searchState.index - 1 + ctx.searchState.matches.length) % ctx.searchState.matches.length;
      ctx.onJumpToMatch();
    }
  },

  // Command mode
  command_start(ctx, _result) {
    ctx.commandState.active = true;
    ctx.commandState.buffer = '';
  },

  command_update(ctx, result) {
    ctx.commandState.buffer = result.buffer;
  },

  command_cancel(ctx, _result) {
    ctx.commandState.active = false;
    ctx.commandState.buffer = '';
  },

  command_execute(ctx, result) {
    ctx.commandState.active = false;
    ctx.commandState.buffer = '';
    ctx.onExecuteCommand(result.command);
  }
};

module.exports = { searchHandlers };
