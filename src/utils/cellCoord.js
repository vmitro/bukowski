// src/utils/cellCoord.js — convert between JS-char-index and cell-column.
//
// `getLineText(i)` returns plain text without xterm wide-char placeholder cells:
//   "中a"  → "中a" (2 JS chars, 3 display cells: 中=2, a=1)
//   "🔂a"  → "🔂a" (3 JS chars: surrogate pair + 'a'; 3 display cells)
//   "áb"  → "áb" (3 JS chars: a + combining acute + b; 2 display cells)
//
// All cursor / search / visual / yank state stores `col` as a *cell column*
// (display cells from line start). These helpers translate to/from the JS-char
// index needed for slicing and regex work, and step grapheme-by-grapheme for
// h/l motions that should respect grapheme boundaries.

const { codePointWidth } = require('../core/ansiUtils');

// Combining/format ranges duplicated from ansiUtils — kept private there. Mirror
// here just for grapheme absorption; if these ever diverge, refactor to share.
const ZERO_WIDTH_RANGES = [
  [0x0300, 0x036F], [0x0483, 0x0489], [0x0591, 0x05BD],
  [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x206F],
  [0xFE00, 0xFE0F], [0xFE20, 0xFE2F],
];

function inRange(cp, ranges) {
  for (let i = 0; i < ranges.length; i++) {
    if (cp < ranges[i][0]) return false;
    if (cp <= ranges[i][1]) return true;
  }
  return false;
}

function decodeCodePoint(text, i) {
  const code = text.charCodeAt(i);
  if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
    const low = text.charCodeAt(i + 1);
    if (low >= 0xDC00 && low <= 0xDFFF) {
      return { cp: 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00), len: 2 };
    }
  }
  return { cp: code, len: 1 };
}

/**
 * One grapheme starting at `charIdx` in `text`. Surrogate pair folded; trailing
 * combining marks absorbed. Returns the grapheme's JS-char length and its width
 * in display cells (0 for combining-only, 2 for wide / emoji, 1 otherwise).
 */
function graphemeAt(text, charIdx) {
  if (charIdx >= text.length) return { charLen: 0, cellWidth: 0 };
  const base = decodeCodePoint(text, charIdx);
  let charLen = base.len;
  const cellWidth = codePointWidth(base.cp) || 1;  // base char never zero-width
  while (charIdx + charLen < text.length) {
    const next = decodeCodePoint(text, charIdx + charLen);
    if (!inRange(next.cp, ZERO_WIDTH_RANGES)) break;
    charLen += next.len;
  }
  return { charLen, cellWidth };
}

/**
 * Cell column reached after consuming `charIdx` JS chars from line start.
 * `charIdx` is clamped to text length; if it falls inside a grapheme, returns
 * the cell column at the grapheme's *start* (does not split a grapheme).
 */
function cellColFromCharIdx(text, charIdx) {
  if (!text) return 0;
  let i = 0, col = 0;
  while (i < text.length && i < charIdx) {
    const g = graphemeAt(text, i);
    if (i + g.charLen > charIdx) break;  // charIdx mid-grapheme → snap to start
    col += g.cellWidth;
    i += g.charLen;
  }
  return col;
}

/**
 * JS-char index for a given cell column. Snaps to grapheme boundary: if
 * `cellCol` lands inside a wide grapheme's trailing cells, returns the
 * grapheme's start char index. Past end, returns text.length.
 */
function charIdxFromCellCol(text, cellCol) {
  if (!text || cellCol <= 0) return 0;
  let i = 0, col = 0;
  while (i < text.length) {
    const g = graphemeAt(text, i);
    if (col + g.cellWidth > cellCol) return i;  // mid-grapheme → snap to start
    col += g.cellWidth;
    i += g.charLen;
    if (col >= cellCol) return i;
  }
  return text.length;
}

/**
 * Total cell width of a line.
 */
function lineCellCount(text) {
  if (!text) return 0;
  let i = 0, col = 0;
  while (i < text.length) {
    const g = graphemeAt(text, i);
    col += g.cellWidth;
    i += g.charLen;
  }
  return col;
}

/**
 * Step right by one grapheme. Returns new char index (clamped to text length).
 */
function stepGraphemeRight(text, charIdx) {
  if (charIdx >= text.length) return text.length;
  const g = graphemeAt(text, charIdx);
  return charIdx + g.charLen;
}

/**
 * Step left by one grapheme. Returns new char index (clamped to 0).
 *
 * Walks from the line start to find the grapheme boundary preceding `charIdx`,
 * since combining marks make backward stepping ambiguous from local lookback.
 */
function stepGraphemeLeft(text, charIdx) {
  if (charIdx <= 0) return 0;
  let i = 0, prev = 0;
  while (i < text.length) {
    const g = graphemeAt(text, i);
    if (i + g.charLen >= charIdx) return i;
    prev = i;
    i += g.charLen;
  }
  return prev;
}

/**
 * Width of the last grapheme in the line, in cells. Useful for "jump to end"
 * which lands on the *start* of the last grapheme (cell-col), so the caller
 * computes `lineCellCount(text) - lastGraphemeCellWidth(text)`.
 */
function lastGraphemeCellWidth(text) {
  if (!text) return 0;
  let i = 0, last = 1;
  while (i < text.length) {
    const g = graphemeAt(text, i);
    last = g.cellWidth;
    i += g.charLen;
  }
  return last;
}

/**
 * Cell column of the *last* grapheme's starting cell. For a line "中a", end col
 * is 2 (cell-col of 'a'); for "ab" it is 1; for "" it is 0.
 */
function lastGraphemeCellCol(text) {
  const total = lineCellCount(text);
  return Math.max(0, total - lastGraphemeCellWidth(text));
}

module.exports = {
  graphemeAt,
  cellColFromCharIdx,
  charIdxFromCellCol,
  lineCellCount,
  stepGraphemeRight,
  stepGraphemeLeft,
  lastGraphemeCellWidth,
  lastGraphemeCellCol,
};
