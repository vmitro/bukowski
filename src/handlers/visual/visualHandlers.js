// src/handlers/visual/visualHandlers.js - Visual mode and selection handlers

const {
  moveWordForward,
  moveWordEnd,
  moveWordBackward
} = require('../../utils/bufferText');

const visualHandlers = {
  mode_change(ctx, result) {
    const focusedAgent = ctx.getFocusedAgent();

    if (result.mode === 'normal' && focusedAgent) {
      // Initialize normal cursor to agent's cursor position
      const buffer = focusedAgent.getBuffer?.();
      if (buffer) {
        ctx.vimState.normalCursor.line = buffer.baseY + buffer.cursorY;
        ctx.vimState.normalCursor.col = buffer.cursorX;
      }
      ctx.vimState.mode = 'normal';
    } else if (result.mode === 'insert') {
      ctx.vimState.mode = 'insert';
    } else if (result.mode === 'visual') {
      // Enter visual char mode, context-aware start position
      const prevMode = ctx.vimState.mode;
      ctx.onEnterVisualMode('visual', prevMode);
    } else if (result.mode === 'visual-line') {
      // Enter visual line mode
      const prevMode = ctx.vimState.mode;
      ctx.onEnterVisualMode('vline', prevMode);
    }
  },

  extend_selection(ctx, result) {
    if (ctx.vimState.mode === 'visual' || ctx.vimState.mode === 'vline') {
      ctx.onMoveVisualCursor(result.dir, result.count || 1);
    }
  },

  extend_half_page(ctx, result) {
    if (ctx.vimState.mode === 'visual' || ctx.vimState.mode === 'vline') {
      const focusedPane = ctx.getFocusedPane();
      const halfPage = Math.floor((focusedPane?.bounds.height || 12) / 2);
      ctx.onMoveVisualCursor(result.dir, halfPage);
    }
  },

  extend_to_top(ctx, _result) {
    if (ctx.vimState.mode === 'visual' || ctx.vimState.mode === 'vline') {
      ctx.vimState.visualCursor.line = 0;
      if (ctx.vimState.mode === 'visual') {
        ctx.vimState.visualCursor.col = 0;
      }
      ctx.ensureLineVisible(0);
    }
  },

  extend_to_bottom(ctx, _result) {
    const focusedAgent = ctx.getFocusedAgent();
    if ((ctx.vimState.mode === 'visual' || ctx.vimState.mode === 'vline') && focusedAgent) {
      const lastLine = focusedAgent.getContentHeight() - 1;
      ctx.vimState.visualCursor.line = Math.max(0, lastLine);
      if (ctx.vimState.mode === 'visual') {
        const lineText = focusedAgent.getLineText(lastLine);
        ctx.vimState.visualCursor.col = Math.max(0, lineText.length - 1);
      }
      ctx.ensureLineVisible(ctx.vimState.visualCursor.line);
    }
  },

  extend_line_start(ctx, _result) {
    if (ctx.vimState.mode === 'visual') {
      ctx.vimState.visualCursor.col = 0;
    }
  },

  extend_line_end(ctx, _result) {
    const focusedAgent = ctx.getFocusedAgent();
    if (ctx.vimState.mode === 'visual' && focusedAgent) {
      const lineText = focusedAgent.getLineText(ctx.vimState.visualCursor.line) || '';
      ctx.vimState.visualCursor.col = Math.max(0, lineText.length - 1);
    }
  },

  extend_first_nonblank(ctx, _result) {
    const focusedAgent = ctx.getFocusedAgent();
    if (ctx.vimState.mode === 'visual' && focusedAgent) {
      const lineText = focusedAgent.getLineText(ctx.vimState.visualCursor.line) || '';
      const match = lineText.match(/^\s*/);
      ctx.vimState.visualCursor.col = match ? match[0].length : 0;
    }
  },

  extend_word_forward(ctx, result) {
    const focusedAgent = ctx.getFocusedAgent();
    if ((ctx.vimState.mode === 'visual' || ctx.vimState.mode === 'vline') && focusedAgent) {
      for (let i = 0; i < (result.count || 1); i++) {
        moveWordForward(focusedAgent, ctx.vimState.visualCursor, result.bigWord);
      }
      ctx.ensureLineVisible(ctx.vimState.visualCursor.line);
    }
  },

  extend_word_end(ctx, result) {
    const focusedAgent = ctx.getFocusedAgent();
    if ((ctx.vimState.mode === 'visual' || ctx.vimState.mode === 'vline') && focusedAgent) {
      for (let i = 0; i < (result.count || 1); i++) {
        moveWordEnd(focusedAgent, ctx.vimState.visualCursor, result.bigWord);
      }
      ctx.ensureLineVisible(ctx.vimState.visualCursor.line);
    }
  },

  extend_word_backward(ctx, result) {
    const focusedAgent = ctx.getFocusedAgent();
    if ((ctx.vimState.mode === 'visual' || ctx.vimState.mode === 'vline') && focusedAgent) {
      for (let i = 0; i < (result.count || 1); i++) {
        moveWordBackward(focusedAgent, ctx.vimState.visualCursor, result.bigWord);
      }
      ctx.ensureLineVisible(ctx.vimState.visualCursor.line);
    }
  },

  visual_cancel(ctx, _result) {
    ctx.vimState.mode = 'normal';
  }
};

module.exports = { visualHandlers };
