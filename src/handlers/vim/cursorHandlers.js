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
  findCharOnLine,
  findParagraphForward,
  findParagraphBackward,
  findMatchingBracket,
  wordUnderCursor
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
  },

  // H / M / L — cursor to top/middle/bottom of viewport.
  cursor_viewport_top(ctx, result) {
    const pane = ctx.getFocusedPane();
    if (!pane) return;
    const scrollY = ctx.getScrollOffset(pane.id);
    const offset = Math.max(0, (result.count || 1) - 1);
    ctx.vimState.normalCursor.line = scrollY + offset;
    ctx.vimState.normalCursor.col = 0;
  },

  cursor_viewport_middle(ctx, _result) {
    const pane = ctx.getFocusedPane();
    if (!pane) return;
    const scrollY = ctx.getScrollOffset(pane.id);
    ctx.vimState.normalCursor.line = scrollY + Math.floor(pane.bounds.height / 2);
    ctx.vimState.normalCursor.col = 0;
  },

  cursor_viewport_bottom(ctx, result) {
    const pane = ctx.getFocusedPane();
    if (!pane) return;
    const scrollY = ctx.getScrollOffset(pane.id);
    const offset = Math.max(0, (result.count || 1) - 1);
    ctx.vimState.normalCursor.line = scrollY + pane.bounds.height - 1 - offset;
    ctx.vimState.normalCursor.col = 0;
  },

  // { / } — paragraph navigation (blank line as separator).
  paragraph_forward(ctx, result) {
    const agent = ctx.getFocusedAgent();
    if (!agent) return;
    let line = ctx.vimState.normalCursor.line;
    for (let i = 0; i < (result.count || 1); i++) {
      line = findParagraphForward(agent, line);
    }
    ctx.vimState.normalCursor.line = line;
    ctx.vimState.normalCursor.col = 0;
    ctx.ensureLineVisible(line);
  },

  paragraph_backward(ctx, result) {
    const agent = ctx.getFocusedAgent();
    if (!agent) return;
    let line = ctx.vimState.normalCursor.line;
    for (let i = 0; i < (result.count || 1); i++) {
      line = findParagraphBackward(agent, line);
    }
    ctx.vimState.normalCursor.line = line;
    ctx.vimState.normalCursor.col = 0;
    ctx.ensureLineVisible(line);
  },

  // % — jump to matching bracket.
  match_bracket(ctx, _result) {
    const agent = ctx.getFocusedAgent();
    if (!agent) return;
    const cursor = ctx.vimState.normalCursor;
    const target = findMatchingBracket(agent, cursor.line, cursor.col);
    if (!target) return;
    cursor.line = target.line;
    cursor.col = target.col;
    ctx.ensureLineVisible(cursor.line);
  },

  // * / # — search word under cursor forward / backward.
  search_word_under_cursor(ctx, result) {
    const agent = ctx.getFocusedAgent();
    if (!agent) return;
    const cursor = ctx.vimState.normalCursor;
    const word = wordUnderCursor(agent, cursor.line, cursor.col);
    if (!word) return;
    ctx.searchState.pattern = `\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`;
    ctx.searchState.direction = result.direction || 'forward';
    ctx.onExecuteSearch();
    // executeSearch lands index at 0 (first match in buffer). For #, advance
    // to the match nearest above the cursor; for * the next match below.
    if (!ctx.searchState.matches?.length) return;
    const matches = ctx.searchState.matches;
    if (result.direction === 'backward') {
      let idx = matches.length - 1;
      for (let i = matches.length - 1; i >= 0; i--) {
        if (matches[i].line < cursor.line ||
            (matches[i].line === cursor.line && matches[i].col < cursor.col)) {
          idx = i;
          break;
        }
      }
      ctx.searchState.index = idx;
    } else {
      let idx = 0;
      for (let i = 0; i < matches.length; i++) {
        if (matches[i].line > cursor.line ||
            (matches[i].line === cursor.line && matches[i].col > cursor.col)) {
          idx = i;
          break;
        }
      }
      ctx.searchState.index = idx;
    }
    ctx.onJumpToMatch();
    // Move cursor to the match itself, vim-style.
    const m = matches[ctx.searchState.index];
    cursor.line = m.line;
    cursor.col = m.col;
  }
};

module.exports = { cursorHandlers };
