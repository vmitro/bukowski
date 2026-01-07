/**
 * Buffer text utilities - text extraction and word movement
 */

/**
 * Extract selected text from agent buffer
 * @param {Object} agent - Agent with getLineText method
 * @param {Object} vimState - Vim state with visualAnchor, visualCursor, mode
 * @returns {string} Selected text
 */
function extractSelectedText(agent, vimState) {
  const anchor = vimState.visualAnchor;
  const cursor = vimState.visualCursor;

  // Determine start and end
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
      // Visual line: full lines
      lines.push(lineText);
    } else {
      // Visual char: partial lines
      if (i === start.line && i === end.line) {
        lines.push(lineText.slice(start.col, end.col + 1));
      } else if (i === start.line) {
        lines.push(lineText.slice(start.col));
      } else if (i === end.line) {
        lines.push(lineText.slice(0, end.col + 1));
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
  let start = col, end = col;
  while (start > 0 && /\w/.test(lineText[start - 1])) start--;
  while (end < lineText.length && /\w/.test(lineText[end])) end++;
  return { text: lineText.slice(start, end), startCol: start, endCol: end - 1 };
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
  return lineText.slice(col);
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
  return lineText.slice(0, col + 1);
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
  let { line, col } = cursor;
  let lineText = agent.getLineText(line) || '';

  // Skip current word
  while (col < lineText.length && isWordChar(lineText[col], bigWord)) {
    col++;
  }
  // Skip whitespace/non-word chars
  while (true) {
    while (col < lineText.length && !isWordChar(lineText[col], bigWord)) {
      col++;
    }
    if (col < lineText.length || line >= contentHeight - 1) break;
    // Move to next line
    line++;
    col = 0;
    lineText = agent.getLineText(line) || '';
  }

  cursor.line = line;
  cursor.col = Math.min(col, Math.max(0, lineText.length - 1));
}

/**
 * Move cursor forward to end of word (mutates cursor)
 * @param {Object} agent - Agent with getLineText and getContentHeight methods
 * @param {Object} cursor - Cursor object with line and col properties (mutated)
 * @param {boolean} bigWord - If true, use WORD definition
 */
function moveWordEnd(agent, cursor, bigWord) {
  const contentHeight = agent.getContentHeight();
  let { line, col } = cursor;
  let lineText = agent.getLineText(line) || '';

  // Move at least one position
  col++;
  // Skip whitespace/non-word chars
  while (true) {
    while (col < lineText.length && !isWordChar(lineText[col], bigWord)) {
      col++;
    }
    if (col < lineText.length || line >= contentHeight - 1) break;
    line++;
    col = 0;
    lineText = agent.getLineText(line) || '';
  }
  // Skip to end of word
  while (col < lineText.length - 1 && isWordChar(lineText[col + 1], bigWord)) {
    col++;
  }

  cursor.line = line;
  cursor.col = Math.min(col, Math.max(0, lineText.length - 1));
}

/**
 * Move cursor backward to start of word (mutates cursor)
 * @param {Object} agent - Agent with getLineText method
 * @param {Object} cursor - Cursor object with line and col properties (mutated)
 * @param {boolean} bigWord - If true, use WORD definition
 */
function moveWordBackward(agent, cursor, bigWord) {
  let { line, col } = cursor;
  let lineText = agent.getLineText(line) || '';

  // Move at least one position
  col--;
  // Skip whitespace/non-word chars
  while (true) {
    while (col >= 0 && !isWordChar(lineText[col], bigWord)) {
      col--;
    }
    if (col >= 0 || line <= 0) break;
    line--;
    lineText = agent.getLineText(line) || '';
    col = lineText.length - 1;
  }
  // Skip to start of word
  while (col > 0 && isWordChar(lineText[col - 1], bigWord)) {
    col--;
  }

  cursor.line = line;
  cursor.col = Math.max(0, col);
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
  const forward = type === 'f' || type === 't';
  const til = type === 't' || type === 'T';
  let col = startCol;
  let found = 0;

  if (forward) {
    for (let i = startCol + 1; i < lineText.length; i++) {
      if (lineText[i] === char) {
        found++;
        col = i;
        if (found >= count) break;
      }
    }
  } else {
    for (let i = startCol - 1; i >= 0; i--) {
      if (lineText[i] === char) {
        found++;
        col = i;
        if (found >= count) break;
      }
    }
  }

  if (found < count) return -1;  // Not found enough times

  // Adjust for til (t/T) - stop before/after the character
  if (til) {
    col = forward ? col - 1 : col + 1;
  }

  return col;
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
  findCharOnLine
};
