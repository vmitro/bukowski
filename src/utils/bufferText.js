/**
 * Buffer text utilities - text extraction and word movement.
 *
 * Cursor.col is a CELL COLUMN (display cells from line start). These helpers
 * convert to JS-char index internally for word-class regex / slicing, then
 * back to cell-col when writing cursor state. See src/utils/cellCoord.js.
 */

const {
  cellColFromCharIdx,
  charIdxFromCellCol,
  lineCellCount,
  lastGraphemeCellCol,
} = require('./cellCoord');

/**
 * Extract selected text from agent buffer
 * @param {Object} agent - Agent with getLineText method
 * @param {Object} vimState - Vim state with visualAnchor, visualCursor, mode
 * @returns {string} Selected text
 */
function extractSelectedText(agent, vimState) {
  const anchor = vimState.visualAnchor;
  const cursor = vimState.visualCursor;

  // Block-wise: rectangle from opposing corners; one slice per row.
  if (vimState.mode === 'vblock') {
    const startLine = Math.min(anchor.line, cursor.line);
    const endLine = Math.max(anchor.line, cursor.line);
    const startCol = Math.min(anchor.col, cursor.col);
    const endCol = Math.max(anchor.col, cursor.col);
    const lines = [];
    for (let i = startLine; i <= endLine; i++) {
      const lineText = agent.getLineText(i) || '';
      const a = charIdxFromCellCol(lineText, startCol);
      const b = charIdxFromCellCol(lineText, endCol + 1);  // inclusive end-cell
      lines.push(lineText.slice(a, b));
    }
    return lines.join('\n');
  }

  let start, end;
  if (anchor.line < cursor.line || (anchor.line === cursor.line && anchor.col <= cursor.col)) {
    start = anchor;
    end = cursor;
  } else {
    start = cursor;
    end = anchor;
  }

  const lines = [];
  for (let i = start.line; i <= end.line; i++) {
    const lineText = agent.getLineText(i);

    if (vimState.mode === 'vline') {
      lines.push(lineText);
    } else {
      // Cols are cell-col; slice on JS-char idx. End is inclusive (vim semantics):
      // step one grapheme past the end-cell to capture the whole grapheme there.
      if (i === start.line && i === end.line) {
        const a = charIdxFromCellCol(lineText, start.col);
        const b = charIdxFromCellCol(lineText, end.col + 1);
        lines.push(lineText.slice(a, b));
      } else if (i === start.line) {
        lines.push(lineText.slice(charIdxFromCellCol(lineText, start.col)));
      } else if (i === end.line) {
        lines.push(lineText.slice(0, charIdxFromCellCol(lineText, end.col + 1)));
      } else {
        lines.push(lineText);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Extract multiple lines from agent buffer
 * @param {Object} agent - Agent with getLineText and getContentHeight methods
 * @param {number} startLine - Starting line number
 * @param {number} count - Number of lines to extract
 * @returns {string} Extracted lines joined with newlines
 */
function extractLines(agent, startLine, count) {
  const lines = [];
  const contentHeight = agent.getContentHeight();
  for (let i = startLine; i < startLine + count && i < contentHeight; i++) {
    lines.push(agent.getLineText(i));
  }
  return lines.join('\n');
}

/**
 * Extract word at cursor position
 * @param {Object} agent - Agent with getLineText method
 * @param {number} line - Line number
 * @param {number} col - Column number
 * @returns {{ text: string, startCol: number, endCol: number }}
 */
function extractWord(agent, line, col) {
  const lineText = agent.getLineText(line) || '';
  let start = charIdxFromCellCol(lineText, col);
  let end = start;
  while (start > 0 && /\w/.test(lineText[start - 1])) start--;
  while (end < lineText.length && /\w/.test(lineText[end])) end++;
  return {
    text: lineText.slice(start, end),
    startCol: cellColFromCharIdx(lineText, start),
    endCol: Math.max(0, cellColFromCharIdx(lineText, end) - 1),
  };
}

/**
 * Extract text from cursor to end of line
 * @param {Object} agent - Agent with getLineText method
 * @param {number} line - Line number
 * @param {number} col - Column number
 * @returns {string}
 */
function extractToEndOfLine(agent, line, col) {
  const lineText = agent.getLineText(line) || '';
  return lineText.slice(charIdxFromCellCol(lineText, col));
}

/**
 * Extract text from start of line to cursor
 * @param {Object} agent - Agent with getLineText method
 * @param {number} line - Line number
 * @param {number} col - Column number
 * @returns {string}
 */
function extractFromStartOfLine(agent, line, col) {
  const lineText = agent.getLineText(line) || '';
  // +1 in cell-col space means "include the grapheme at `col`".
  return lineText.slice(0, charIdxFromCellCol(lineText, col + 1));
}

/**
 * Check if character is a word character
 * word = letters, digits, underscores
 * WORD = any non-whitespace
 * @param {string} char - Character to check
 * @param {boolean} bigWord - If true, use WORD definition
 * @returns {boolean}
 */
function isWordChar(char, bigWord) {
  if (!char) return false;
  if (bigWord) return !/\s/.test(char);
  return /\w/.test(char);
}

/**
 * Move cursor forward to start of next word (mutates cursor)
 * @param {Object} agent - Agent with getLineText and getContentHeight methods
 * @param {Object} cursor - Cursor object with line and col properties (mutated)
 * @param {boolean} bigWord - If true, use WORD definition
 */
function moveWordForward(agent, cursor, bigWord) {
  const contentHeight = agent.getContentHeight();
  let line = cursor.line;
  let lineText = agent.getLineText(line) || '';
  let col = charIdxFromCellCol(lineText, cursor.col);

  while (col < lineText.length && isWordChar(lineText[col], bigWord)) col++;
  while (true) {
    while (col < lineText.length && !isWordChar(lineText[col], bigWord)) col++;
    if (col < lineText.length || line >= contentHeight - 1) break;
    line++;
    col = 0;
    lineText = agent.getLineText(line) || '';
  }

  cursor.line = line;
  // Clamp char-idx to last grapheme start, then convert to cell-col.
  const clampedIdx = Math.min(col, lineText.length);
  const cellCol = cellColFromCharIdx(lineText, clampedIdx);
  cursor.col = Math.min(cellCol, lastGraphemeCellCol(lineText));
}

/**
 * Move cursor forward to end of word (mutates cursor)
 * @param {Object} agent - Agent with getLineText and getContentHeight methods
 * @param {Object} cursor - Cursor object with line and col properties (mutated)
 * @param {boolean} bigWord - If true, use WORD definition
 */
function moveWordEnd(agent, cursor, bigWord) {
  const contentHeight = agent.getContentHeight();
  let line = cursor.line;
  let lineText = agent.getLineText(line) || '';
  let col = charIdxFromCellCol(lineText, cursor.col);

  col++;
  while (true) {
    while (col < lineText.length && !isWordChar(lineText[col], bigWord)) col++;
    if (col < lineText.length || line >= contentHeight - 1) break;
    line++;
    col = 0;
    lineText = agent.getLineText(line) || '';
  }
  while (col < lineText.length - 1 && isWordChar(lineText[col + 1], bigWord)) col++;

  cursor.line = line;
  const clampedIdx = Math.min(col, Math.max(0, lineText.length - 1));
  cursor.col = cellColFromCharIdx(lineText, clampedIdx);
}

/**
 * Move cursor backward to start of word (mutates cursor)
 * @param {Object} agent - Agent with getLineText method
 * @param {Object} cursor - Cursor object with line and col properties (mutated)
 * @param {boolean} bigWord - If true, use WORD definition
 */
function moveWordBackward(agent, cursor, bigWord) {
  let line = cursor.line;
  let lineText = agent.getLineText(line) || '';
  let col = charIdxFromCellCol(lineText, cursor.col);

  col--;
  while (true) {
    while (col >= 0 && !isWordChar(lineText[col], bigWord)) col--;
    if (col >= 0 || line <= 0) break;
    line--;
    lineText = agent.getLineText(line) || '';
    col = lineText.length - 1;
  }
  while (col > 0 && isWordChar(lineText[col - 1], bigWord)) col--;

  cursor.line = line;
  cursor.col = cellColFromCharIdx(lineText, Math.max(0, col));
}

/**
 * Find character on line (f/F/t/T motions)
 * @param {string} lineText - Text of the line
 * @param {number} startCol - Starting column
 * @param {string} char - Character to find
 * @param {string} type - Motion type: 'f', 'F', 't', or 'T'
 * @param {number} count - Number of times to find (default 1)
 * @returns {number} New column position or -1 if not found
 */
function findCharOnLine(lineText, startCol, char, type, count = 1) {
  // startCol / return value are CELL COLUMNS. Internal scan is on JS-char idx.
  const forward = type === 'f' || type === 't';
  const til = type === 't' || type === 'T';
  const startIdx = charIdxFromCellCol(lineText, startCol);
  let foundIdx = -1;
  let found = 0;

  if (forward) {
    for (let i = startIdx + 1; i < lineText.length; i++) {
      if (lineText[i] === char) {
        found++;
        foundIdx = i;
        if (found >= count) break;
      }
    }
  } else {
    for (let i = startIdx - 1; i >= 0; i--) {
      if (lineText[i] === char) {
        found++;
        foundIdx = i;
        if (found >= count) break;
      }
    }
  }

  if (found < count) return -1;

  let cellCol = cellColFromCharIdx(lineText, foundIdx);
  // For t/T, stop one cell before/after — using cell offsets, not char offsets.
  if (til) cellCol = forward ? cellCol - 1 : cellCol + 1;
  return cellCol;
}

/**
 * Find the next paragraph boundary forward (first blank line below `line`).
 * If `line` itself is blank, skip the current run of blanks first so we land
 * on a *different* paragraph boundary, vim-style. Returns last line index if
 * no further blank line exists.
 */
function findParagraphForward(agent, line) {
  const total = agent.getContentHeight();
  let i = line;
  // Skip the current blank-line run, if any.
  while (i < total && /^\s*$/.test(agent.getLineText(i) || '')) i++;
  // Walk to the next blank line.
  while (i < total && !/^\s*$/.test(agent.getLineText(i) || '')) i++;
  return Math.min(i, total - 1);
}

/**
 * Find the next paragraph boundary backward (first blank line above `line`).
 * Mirror of findParagraphForward.
 */
function findParagraphBackward(agent, line) {
  let i = line;
  while (i > 0 && /^\s*$/.test(agent.getLineText(i) || '')) i--;
  while (i > 0 && !/^\s*$/.test(agent.getLineText(i) || '')) i--;
  return Math.max(0, i);
}

const BRACKET_PAIRS = { '(': ')', '[': ']', '{': '}', ')': '(', ']': '[', '}': '{' };
const BRACKET_FORWARD = new Set(['(', '[', '{']);

/**
 * Find the bracket matching the one at (line, col). If no bracket is at the
 * cursor, scan forward on the same line for the first bracket. Returns
 * `{line, col}` (cell-col) of the matching bracket, or null if unmatched.
 */
function findMatchingBracket(agent, line, col) {
  const total = agent.getContentHeight();
  let lineText = agent.getLineText(line) || '';
  let charIdx = charIdxFromCellCol(lineText, col);

  // If not on a bracket, scan forward on this line for one.
  while (charIdx < lineText.length && !BRACKET_PAIRS[lineText[charIdx]]) charIdx++;
  if (charIdx >= lineText.length) return null;

  const open = lineText[charIdx];
  const target = BRACKET_PAIRS[open];
  const forward = BRACKET_FORWARD.has(open);
  let depth = 1;

  if (forward) {
    let i = line, c = charIdx + 1;
    while (i < total) {
      if (c >= lineText.length) {
        i++;
        if (i >= total) break;
        lineText = agent.getLineText(i) || '';
        c = 0;
        continue;
      }
      const ch = lineText[c];
      if (ch === open) depth++;
      else if (ch === target) {
        depth--;
        if (depth === 0) return { line: i, col: cellColFromCharIdx(lineText, c) };
      }
      c++;
    }
  } else {
    let i = line, c = charIdx - 1;
    while (i >= 0) {
      if (c < 0) {
        i--;
        if (i < 0) break;
        lineText = agent.getLineText(i) || '';
        c = lineText.length - 1;
        continue;
      }
      const ch = lineText[c];
      if (ch === open) depth++;
      else if (ch === target) {
        depth--;
        if (depth === 0) return { line: i, col: cellColFromCharIdx(lineText, c) };
      }
      c--;
    }
  }

  return null;
}

/**
 * Word under cursor — used by `*` and `#`. Returns the word text or null.
 */
function wordUnderCursor(agent, line, col) {
  const lineText = agent.getLineText(line) || '';
  const idx = charIdxFromCellCol(lineText, col);
  if (!/\w/.test(lineText[idx] || '')) {
    // Not on a word char; scan forward for one (vim falls back to next word).
    let j = idx;
    while (j < lineText.length && !/\w/.test(lineText[j])) j++;
    if (j >= lineText.length) return null;
    return readWordAt(lineText, j);
  }
  return readWordAt(lineText, idx);
}

function readWordAt(lineText, idx) {
  let s = idx;
  while (s > 0 && /\w/.test(lineText[s - 1])) s--;
  let e = idx;
  while (e < lineText.length && /\w/.test(lineText[e])) e++;
  return lineText.slice(s, e);
}

/**
 * Text-object range: returns {startLine, startCol, endLine, endCol} as
 * cell-cols, or null if no object found at the cursor. `kind` is one of:
 *   'w' | 'W' — word / WORD (around=true adds trailing whitespace)
 *   '"' | "'" | '`' — same-line quoted run
 *   '(' | ')' | 'b' | '[' | ']' | '{' | '}' | 'B' — bracket pair (multi-line)
 *   'p' — paragraph (around=true adds the trailing blank-line run)
 */
function findTextObject(agent, line, col, kind, around) {
  if (kind === 'w' || kind === 'W') return findWordTextObject(agent, line, col, kind === 'W', around);
  if (kind === '"' || kind === "'" || kind === '`') return findQuoteTextObject(agent, line, col, kind, around);
  if ('()b[]{}B'.includes(kind)) return findBracketTextObject(agent, line, col, kind, around);
  if (kind === 'p') return findParagraphTextObject(agent, line, around);
  return null;
}

function findWordTextObject(agent, line, col, bigWord, around) {
  const lineText = agent.getLineText(line) || '';
  if (!lineText) return null;
  const idx = charIdxFromCellCol(lineText, col);
  const ch = lineText[idx];
  if (ch === undefined) return null;

  const cls = bigWord ? bigWordClass : wordClass;
  const startClass = cls(ch);

  // Expand to the run of same-class characters around idx.
  let s = idx, e = idx;
  while (s > 0 && cls(lineText[s - 1]) === startClass) s--;
  while (e < lineText.length - 1 && cls(lineText[e + 1]) === startClass) e++;

  if (around) {
    // 'aw' adds trailing whitespace; if there's none, fall back to leading.
    if (e + 1 < lineText.length && /\s/.test(lineText[e + 1])) {
      while (e + 1 < lineText.length && /\s/.test(lineText[e + 1])) e++;
    } else if (s > 0 && /\s/.test(lineText[s - 1])) {
      while (s > 0 && /\s/.test(lineText[s - 1])) s--;
    }
  }

  return {
    startLine: line, startCol: cellColFromCharIdx(lineText, s),
    endLine: line, endCol: cellColFromCharIdx(lineText, e)
  };
}

function wordClass(ch) {
  if (!ch) return 'eof';
  if (/\s/.test(ch)) return 'space';
  if (/\w/.test(ch)) return 'word';
  return 'punct';
}

function bigWordClass(ch) {
  if (!ch) return 'eof';
  if (/\s/.test(ch)) return 'space';
  return 'word';
}

function findQuoteTextObject(agent, line, col, quote, around) {
  const lineText = agent.getLineText(line) || '';
  const idx = charIdxFromCellCol(lineText, col);

  // Find the surrounding quote pair on the same line. If cursor is between
  // two quotes, use those; otherwise take the next pair on the line.
  const positions = [];
  for (let i = 0; i < lineText.length; i++) {
    if (lineText[i] === quote) positions.push(i);
  }
  if (positions.length < 2) return null;

  let openIdx = -1, closeIdx = -1;
  for (let i = 0; i + 1 < positions.length; i += 2) {
    const a = positions[i], b = positions[i + 1];
    if (idx >= a && idx <= b) { openIdx = a; closeIdx = b; break; }
    if (a > idx) { openIdx = a; closeIdx = b; break; }
  }
  if (openIdx < 0) return null;

  let s, e;
  if (around) {
    s = openIdx;
    e = closeIdx;
  } else {
    s = openIdx + 1;
    e = closeIdx - 1;
    if (s > e) return null;  // empty quote run
  }

  return {
    startLine: line, startCol: cellColFromCharIdx(lineText, s),
    endLine: line, endCol: cellColFromCharIdx(lineText, e)
  };
}

const BRACKET_OBJECT_OPEN = {
  '(': '(', ')': '(', 'b': '(',
  '[': '[', ']': '[',
  '{': '{', '}': '{', 'B': '{'
};

function findBracketTextObject(agent, line, col, kind, around) {
  const open = BRACKET_OBJECT_OPEN[kind];
  if (!open) return null;
  const close = { '(': ')', '[': ']', '{': '}' }[open];

  // Locate the enclosing pair: walk backward from cursor for an unmatched open,
  // then findMatchingBracket from there to get the close.
  const openPos = findEnclosingOpen(agent, line, col, open, close);
  if (!openPos) return null;
  const closePos = findMatchingBracket(agent, openPos.line, openPos.col);
  if (!closePos) return null;

  const startLine = openPos.line, endLine = closePos.line;
  const openLineText = agent.getLineText(startLine) || '';
  const closeLineText = agent.getLineText(endLine) || '';
  const openCharIdx = charIdxFromCellCol(openLineText, openPos.col);
  const closeCharIdx = charIdxFromCellCol(closeLineText, closePos.col);

  let startCol, endCol;
  if (around) {
    startCol = openPos.col;
    endCol = closePos.col;
  } else {
    // Inner: skip the bracket itself. If they're on the same line, content
    // runs from openCharIdx+1 .. closeCharIdx-1.
    if (startLine === endLine) {
      const sIdx = openCharIdx + 1, eIdx = closeCharIdx - 1;
      if (sIdx > eIdx) return null;
      startCol = cellColFromCharIdx(openLineText, sIdx);
      endCol = cellColFromCharIdx(closeLineText, eIdx);
    } else {
      startCol = cellColFromCharIdx(openLineText, openCharIdx + 1);
      endCol = closeCharIdx > 0
        ? cellColFromCharIdx(closeLineText, closeCharIdx - 1)
        : 0;
    }
  }

  return { startLine, startCol, endLine, endCol };
}

function findEnclosingOpen(agent, line, col, open, close) {
  // Walk back from (line, col), tracking depth, until we find an unmatched open.
  let l = line;
  let lineText = agent.getLineText(l) || '';
  let c = charIdxFromCellCol(lineText, col);
  let depth = 0;

  // If cursor sits *on* an open bracket, that's the enclosing one.
  if (lineText[c] === open) {
    return { line: l, col: cellColFromCharIdx(lineText, c) };
  }

  while (l >= 0) {
    while (c >= 0) {
      const ch = lineText[c];
      if (ch === close) depth++;
      else if (ch === open) {
        if (depth === 0) return { line: l, col: cellColFromCharIdx(lineText, c) };
        depth--;
      }
      c--;
    }
    l--;
    if (l < 0) break;
    lineText = agent.getLineText(l) || '';
    c = lineText.length - 1;
  }
  return null;
}

function findParagraphTextObject(agent, line, around) {
  const total = agent.getContentHeight();
  const isBlank = (i) => /^\s*$/.test(agent.getLineText(i) || '');

  // Walk back to start of current run (blank or non-blank).
  let s = line;
  const onBlank = isBlank(s);
  while (s > 0 && isBlank(s - 1) === onBlank) s--;

  // Walk forward to end of current run.
  let e = line;
  while (e < total - 1 && isBlank(e + 1) === onBlank) e++;

  if (around) {
    // 'ap' adds the next blank-line run (or non-blank if we started blank).
    let extE = e;
    while (extE < total - 1 && isBlank(extE + 1) !== onBlank) extE++;
    e = extE;
  }

  const endLineText = agent.getLineText(e) || '';
  return {
    startLine: s, startCol: 0,
    endLine: e, endCol: Math.max(0, lineCellCount(endLineText) - 1)
  };
}

module.exports = {
  extractSelectedText,
  extractLines,
  extractWord,
  extractToEndOfLine,
  extractFromStartOfLine,
  isWordChar,
  moveWordForward,
  moveWordEnd,
  moveWordBackward,
  findCharOnLine,
  findParagraphForward,
  findParagraphBackward,
  findMatchingBracket,
  wordUnderCursor,
  findTextObject
};
