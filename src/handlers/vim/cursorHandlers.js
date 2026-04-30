/**
 * Vim cursor movement handlers.
 *
 * `cursor.col` is a cell column. h/l step by one grapheme; line-end /
 * first-nonblank land on a grapheme boundary. See src/utils/cellCoord.js.
 */

const {
  moveWordForward,
  moveWordEnd,
  moveWordBackward,
  findCharOnLine
} = require('../../utils/bufferText');
const {
  cellColFromCharIdx,
  charIdxFromCellCol,
  lineCellCount,
  lastGraphemeCellCol,
  stepGraphemeLeft,
  stepGraphemeRight,
} = require('../../utils/cellCoord');

const cursorHandlers = {
  cursor_down(ctx, result) {
    const agent = ctx.getFocusedAgent();
    if (!agent) return;
    const contentHeight = agent.getContentHeight();
    for (let i = 0; i < (result.count || 1); i++) {
      if (ctx.vimState.normalCursor.line < contentHeight - 1) {
        ctx.vimState.normalCursor.line++;
      }
    }
    ctx.ensureLineVisible(ctx.vimState.normalCursor.line);
  },

  cursor_up(ctx, result) {
    for (let i = 0; i < (result.count || 1); i++) {
      if (ctx.vimState.normalCursor.line > 0) {
        ctx.vimState.normalCursor.line--;
      }
    }
    ctx.ensureLineVisible(ctx.vimState.normalCursor.line);
  },

  cursor_left(ctx, result) {
    const agent = ctx.getFocusedAgent();
    if (!agent) return;
    const lineText = agent.getLineText(ctx.vimState.normalCursor.line) || '';
    let charIdx = charIdxFromCellCol(lineText, ctx.vimState.normalCursor.col);
    for (let i = 0; i < (result.count || 1); i++) {
      if (charIdx <= 0) break;
      charIdx = stepGraphemeLeft(lineText, charIdx);
    }
    ctx.vimState.normalCursor.col = cellColFromCharIdx(lineText, charIdx);
  },

  cursor_right(ctx, result) {
    const agent = ctx.getFocusedAgent();
    if (!agent) return;
    const lineText = agent.getLineText(ctx.vimState.normalCursor.line) || '';
    const lastCol = lastGraphemeCellCol(lineText);
    let charIdx = charIdxFromCellCol(lineText, ctx.vimState.normalCursor.col);
    for (let i = 0; i < (result.count || 1); i++) {
      const next = stepGraphemeRight(lineText, charIdx);
      // vim 'l' stops on the last grapheme, doesn't move past it
      if (cellColFromCharIdx(lineText, next) > lastCol) break;
      charIdx = next;
    }
    ctx.vimState.normalCursor.col = cellColFromCharIdx(lineText, charIdx);
  },

  cursor_line_start(ctx, _result) {
    ctx.vimState.normalCursor.col = 0;
  },

  cursor_line_end(ctx, _result) {
    const agent = ctx.getFocusedAgent();
    if (agent) {
      const lineText = agent.getLineText(ctx.vimState.normalCursor.line) || '';
      ctx.vimState.normalCursor.col = lastGraphemeCellCol(lineText);
    }
  },

  cursor_first_nonblank(ctx, _result) {
    const agent = ctx.getFocusedAgent();
    if (agent) {
      const lineText = agent.getLineText(ctx.vimState.normalCursor.line) || '';
      const match = lineText.match(/^\s*/);
      const charIdx = match ? match[0].length : 0;
      ctx.vimState.normalCursor.col = cellColFromCharIdx(lineText, charIdx);
    }
  },

  // Word movements
  word_forward(ctx, result) {
    const agent = ctx.getFocusedAgent();
    if (agent) {
      for (let i = 0; i < (result.count || 1); i++) {
        moveWordForward(agent, ctx.vimState.normalCursor, result.bigWord);
      }
      ctx.ensureLineVisible(ctx.vimState.normalCursor.line);
    }
  },

  word_end(ctx, result) {
    const agent = ctx.getFocusedAgent();
    if (agent) {
      for (let i = 0; i < (result.count || 1); i++) {
        moveWordEnd(agent, ctx.vimState.normalCursor, result.bigWord);
      }
      ctx.ensureLineVisible(ctx.vimState.normalCursor.line);
    }
  },

  word_backward(ctx, result) {
    const agent = ctx.getFocusedAgent();
    if (agent) {
      for (let i = 0; i < (result.count || 1); i++) {
        moveWordBackward(agent, ctx.vimState.normalCursor, result.bigWord);
      }
      ctx.ensureLineVisible(ctx.vimState.normalCursor.line);
    }
  },

  // Character find (f/F/t/T)
  find_char(ctx, result) {
    const agent = ctx.getFocusedAgent();
    if (agent) {
      const lineText = agent.getLineText(ctx.vimState.normalCursor.line) || '';
      const newCol = findCharOnLine(lineText, ctx.vimState.normalCursor.col, result.char, result.type, result.count || 1);
      if (newCol >= 0) {
        ctx.vimState.normalCursor.col = newCol;
      }
    }
  },

  extend_find_char(ctx, result) {
    const agent = ctx.getFocusedAgent();
    if ((ctx.vimState.mode === 'visual' || ctx.vimState.mode === 'vline' || ctx.vimState.mode === 'vblock') && agent) {
      const lineText = agent.getLineText(ctx.vimState.visualCursor.line) || '';
      const newCol = findCharOnLine(lineText, ctx.vimState.visualCursor.col, result.char, result.type, result.count || 1);
      if (newCol >= 0) {
        ctx.vimState.visualCursor.col = newCol;
      }
    }
  }
};

module.exports = { cursorHandlers };
