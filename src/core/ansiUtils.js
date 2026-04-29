// src/core/ansiUtils.js - ANSI walker + display-width helpers
//
// Lines emitted by Agent.getLine() are *supposed* to contain only SGR (`\x1b[...m`),
// but anything that bypasses the cell reconstructor (overlay text, search highlights,
// future agents that emit OSC hyperlinks, etc.) can sneak other sequences in.
// fitToWidth and the highlight helpers used to recognize only `m`-terminated CSI,
// silently treating CUP/CHA/EL/OSC as visible characters and breaking padding.
//
// This module knows about: CSI (`\x1b[...<final>`), OSC (`\x1b]...ST`), DCS/SOS/PM/APC
// (`\x1bP/X/^/_...ST`), and bare escapes (`\x1bM`, `\x1b7`, etc.). It also computes
// display width with wide-char awareness (CJK ranges + emoji surrogate pairs treated
// as 2 columns; combining marks treated as 0).
//
// Width tables are deliberately small — exact wcwidth would mean shipping a 500KB
// table; the ranges below cover the realistic content that flows through panes.
//
// Token shape from walkAnsi():
//   { type: 'ansi', value }       — pass-through, contributes 0 to width
//   { type: 'char', value, width } — visible char (or grapheme), contributes `width`

// East Asian Wide / Fullwidth ranges (subset of UAX #11 W/F).
// Approximation: covers CJK ideographs, hiragana/katakana, hangul, fullwidth forms.
const WIDE_RANGES = [
  [0x1100, 0x115F],   // Hangul Jamo
  [0x2E80, 0x303E],   // CJK Radicals .. CJK Symbols
  [0x3041, 0x33FF],   // Hiragana .. CJK Compatibility
  [0x3400, 0x4DBF],   // CJK Extension A
  [0x4E00, 0x9FFF],   // CJK Unified Ideographs
  [0xA000, 0xA4CF],   // Yi
  [0xAC00, 0xD7A3],   // Hangul Syllables
  [0xF900, 0xFAFF],   // CJK Compatibility Ideographs
  [0xFE30, 0xFE4F],   // CJK Compatibility Forms
  [0xFF00, 0xFF60],   // Fullwidth Forms (the half-width forms 0xFF61+ are narrow)
  [0xFFE0, 0xFFE6],   // Fullwidth signs
];

// Combining marks (zero width). Subset of Mn/Me/Cf categories that show up in
// terminal output. Combining diacriticals + variation selectors + zwj/zwnj.
const ZERO_WIDTH_RANGES = [
  [0x0300, 0x036F],   // Combining Diacritical Marks
  [0x0483, 0x0489],
  [0x0591, 0x05BD],
  [0x200B, 0x200F],   // ZWSP, ZWNJ, ZWJ, LRM, RLM
  [0x202A, 0x202E],   // BIDI overrides
  [0x2060, 0x206F],   // Word joiner, invisible operators
  [0xFE00, 0xFE0F],   // Variation Selectors 1-16
  [0xFE20, 0xFE2F],   // Combining Half Marks
];

function inRange(cp, ranges) {
  for (let i = 0; i < ranges.length; i++) {
    if (cp < ranges[i][0]) return false;  // ranges are sorted
    if (cp <= ranges[i][1]) return true;
  }
  return false;
}

/**
 * Width of a single Unicode code point, in terminal cells.
 * Returns 0 for combining marks / control, 2 for CJK / emoji / fullwidth, 1 otherwise.
 */
function codePointWidth(cp) {
  if (cp < 0x20) return 0;                // C0 controls (incl. NUL, BEL, BS, etc.)
  if (cp >= 0x7F && cp < 0xA0) return 0;  // DEL + C1
  if (inRange(cp, ZERO_WIDTH_RANGES)) return 0;
  if (cp >= 0x10000) {
    // Astral plane: emoji (most), CJK Extension B+, etc. Treat as 2 cols.
    // This matches xterm/iTerm/most modern terminals for emoji.
    return 2;
  }
  if (inRange(cp, WIDE_RANGES)) return 2;
  return 1;
}

/**
 * Walk a line and yield ANSI-pass-through tokens vs. visible-char tokens.
 *
 * Visible-char tokens are emitted at grapheme granularity *just enough* to keep
 * width math correct: a base char + any immediately following combining marks
 * are bundled into one token (so `á` stays atomic, you can't truncate between
 * the `a` and the combining acute). Surrogate pairs are bundled likewise.
 *
 * Yields { type: 'ansi'|'char', value, width? }.
 */
function* walkAnsi(line) {
  const len = line.length;
  let i = 0;

  while (i < len) {
    const ch = line[i];
    const code = line.charCodeAt(i);

    if (ch === '\x1b' && i + 1 < len) {
      const next = line[i + 1];
      let end = i + 2;

      if (next === '[') {
        // CSI: parameter bytes 0x30-0x3F, intermediate 0x20-0x2F, final 0x40-0x7E
        while (end < len) {
          const c = line.charCodeAt(end);
          if (c >= 0x40 && c <= 0x7E) { end++; break; }
          end++;
        }
      } else if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
        // OSC / DCS / SOS / PM / APC — terminated by BEL (0x07) or ST (`\x1b\\`)
        while (end < len) {
          const c = line.charCodeAt(end);
          if (c === 0x07) { end++; break; }
          if (c === 0x1b && end + 1 < len && line[end + 1] === '\\') { end += 2; break; }
          end++;
        }
      } else {
        // Two-byte escape: ESC + 1 char (e.g. `\x1bM`, `\x1b7`, `\x1b8`, `\x1bD`).
        // Some take an additional byte (charset selectors `\x1b(B`); we capture
        // intermediates 0x20-0x2F + one final.
        while (end < len) {
          const c = line.charCodeAt(end);
          if (c >= 0x20 && c <= 0x2F) { end++; continue; }
          end++;
          break;
        }
      }

      yield { type: 'ansi', value: line.substring(i, end) };
      i = end;
      continue;
    }

    // Visible char. Handle surrogate pair, then absorb trailing combining marks.
    let charEnd = i + 1;
    let cp = code;
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < len) {
      const low = line.charCodeAt(i + 1);
      if (low >= 0xDC00 && low <= 0xDFFF) {
        cp = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
        charEnd = i + 2;
      }
    }
    const width = codePointWidth(cp);

    // Absorb combining marks (zero-width) so we never split a grapheme.
    // Use the explicit combining/format range — not codePointWidth, which also
    // returns 0 for control chars (don't want to absorb a stray ESC into 'o').
    while (charEnd < len) {
      const cc = line.charCodeAt(charEnd);
      let mcp = cc;
      let nextEnd = charEnd + 1;
      if (cc >= 0xD800 && cc <= 0xDBFF && charEnd + 1 < len) {
        const low = line.charCodeAt(charEnd + 1);
        if (low >= 0xDC00 && low <= 0xDFFF) {
          mcp = 0x10000 + ((cc - 0xD800) << 10) + (low - 0xDC00);
          nextEnd = charEnd + 2;
        }
      }
      if (!inRange(mcp, ZERO_WIDTH_RANGES)) break;
      charEnd = nextEnd;
    }

    yield { type: 'char', value: line.substring(i, charEnd), width };
    i = charEnd;
  }
}

/**
 * Strip all ANSI escape sequences (CSI, OSC, DCS, bare ESC) from a string.
 */
function stripAnsi(line) {
  let out = '';
  for (const tok of walkAnsi(line)) {
    if (tok.type === 'char') out += tok.value;
  }
  return out;
}

/**
 * Total display width of a line (in terminal cells), ignoring ANSI sequences.
 */
function visualWidth(line) {
  let w = 0;
  for (const tok of walkAnsi(line)) {
    if (tok.type === 'char') w += tok.width;
  }
  return w;
}

module.exports = { walkAnsi, stripAnsi, visualWidth, codePointWidth };
