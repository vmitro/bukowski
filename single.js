#!/usr/bin/env node
// bukowski - flicker-free terminal viewport for Ink-based CLI apps

const path = require('path');
const { execSync } = require('child_process');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { VimHandler } = require('./vim');
const { SearchHandler } = require('./search');

// Load quotes from quotes.txt (format: text\n— author\n\n)
const fs = require('fs');
const quotesPath = path.join(__dirname, 'quotes.txt');
let QUOTES = [];
try {
  const raw = fs.readFileSync(quotesPath, 'utf8');
  QUOTES = raw.split(/\n\n+/).filter(Boolean).map(block => {
    const lines = block.trim().split('\n');
    const author = lines.pop().replace(/^—\s*/, '');
    const text = lines.join(' ');
    return { text, author };
  });
} catch (e) {
  QUOTES = [{ text: "Let there be light.", author: "bukowski" }];
}

function showSplash() {
  const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  // Center the quote
  const lines = quote.text.match(new RegExp(`.{1,${cols - 4}}(\\s|$)`, 'g')) || [quote.text];
  const authorLine = `— ${quote.author}`;

  const startRow = Math.floor((rows - lines.length - 2) / 2);

  let frame = '\x1b[2J\x1b[H';  // Clear screen
  frame += '\x1b[?25l';  // Hide cursor

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const col = Math.floor((cols - line.length) / 2);
    frame += `\x1b[${startRow + i};${col}H\x1b[3m${line}\x1b[0m`;  // Italic
  }

  const authorCol = Math.floor((cols - authorLine.length) / 2);
  frame += `\x1b[${startRow + lines.length + 1};${authorCol}H\x1b[2m${authorLine}\x1b[0m`;  // Dim

  process.stdout.write(frame);
}

// Find Claude CLI
const claudeBin = execSync('readlink -f "$(which claude)"', { encoding: 'utf8' }).trim();
const claudeDir = path.dirname(claudeBin);
const claudePath = path.join(claudeDir, 'cli.js');

// Alt screen buffer
process.stdout.write('\x1b[?1049h');

// Show splash
showSplash();

class Viewport {
  constructor() {
    const cols = process.stdout.columns || 80;
    const rows = parseInt(process.env.BUKOWSKI_ROWS) || (process.stdout.rows || 24);

    this.term = new Terminal({
      cols,
      rows,
      scrollback: parseInt(process.env.BUKOWSKI_SCROLLBACK) || 10000,
      allowProposedApi: true
    });

    this.serialize = new SerializeAddon();
    this.term.loadAddon(this.serialize);

    this.offset = 0;
    this.followTail = true;
    this.drawScheduled = false;

    // Vim mode state
    this.mode = 'insert';        // 'insert' | 'normal' | 'visual' | 'vline'
    this.commandPending = false; // true after Ctrl+Space, awaiting mode key
    this.prevMode = 'insert';    // track where we came from for visual mode

    // Normal mode virtual cursor
    this.normalCursor = { line: 0, col: 0 };

    // Visual mode state (used by VimHandler)
    this.visualAnchor = { line: 0, col: 0 };
    this.visualCursor = { line: 0, col: 0 };

    // Handlers
    this.vim = new VimHandler(this);
    this.search = new SearchHandler(this);
  }

  get height() { return Math.max(1, process.stdout.rows - 1); }
  get width() { return process.stdout.columns || 80; }

  push(data) {
    try {
      this.term.write(data);
    } catch (e) {
      // xterm.js can fail on buffer overflow - log but don't crash
      process.stderr.write(`\n[viewport] xterm error: ${e.message}\n`);
    }
    this.scheduleDraw();
  }

  scheduleDraw() {
    // Throttle: draw at most every 16ms (~60fps), always latest frame
    if (!this.drawScheduled) {
      this.drawScheduled = true;
      setTimeout(() => {
        this.drawScheduled = false;
        if (this.followTail) {
          this.scrollToBottom();
        }
        this.draw();
      }, 16);
    }
  }

  get contentHeight() {
    const buffer = this.term.buffer.active;
    return buffer.baseY + buffer.cursorY + 1;
  }

  scrollToBottom() {
    this.offset = Math.max(0, this.contentHeight - this.height);
  }

  scroll(n) {
    const totalLines = this.contentHeight;
    const maxOffset = Math.max(0, totalLines - this.height);
    const oldOffset = this.offset;

    this.offset = Math.max(0, Math.min(maxOffset, this.offset + n));
    this.followTail = (this.offset >= maxOffset);

    if (this.offset !== oldOffset) {
      this.draw();
    }
  }

  getLine(index) {
    const buffer = this.term.buffer.active;
    if (index < 0 || index >= buffer.length) return '';

    const line = buffer.getLine(index);
    if (!line) return '';

    let result = '';
    let lastSgr = '';

    for (let i = 0; i < line.length; i++) {
      const cell = line.getCell(i);
      if (!cell) break;

      const char = cell.getChars();
      if (!char) continue;

      // Build SGR sequence based on cell attributes
      let sgr = [];

      // Attributes
      if (cell.isBold()) sgr.push(1);
      if (cell.isDim()) sgr.push(2);
      if (cell.isItalic()) sgr.push(3);
      if (cell.isUnderline()) sgr.push(4);
      if (cell.isBlink()) sgr.push(5);
      if (cell.isInverse()) sgr.push(7);
      if (cell.isInvisible()) sgr.push(8);
      if (cell.isStrikethrough()) sgr.push(9);

      // Foreground color - check color mode (xterm.js uses bit flags)
      // 0x0 = default, 0x1000000 = 16-color, 0x2000000 = 256-color, 0x3000000 = RGB
      const fgMode = cell.getFgColorMode();
      if (fgMode === 0x1000000) {
        const fg = cell.getFgColor();
        if (fg < 8) sgr.push(30 + fg);
        else sgr.push(90 + fg - 8);
      } else if (fgMode === 0x2000000) {
        sgr.push(38, 5, cell.getFgColor());
      } else if (fgMode === 0x3000000) {
        // RGB - getFgColor returns packed RGB
        const rgb = cell.getFgColor();
        const r = (rgb >> 16) & 0xFF;
        const g = (rgb >> 8) & 0xFF;
        const b = rgb & 0xFF;
        sgr.push(38, 2, r, g, b);
      }

      // Background color
      const bgMode = cell.getBgColorMode();
      if (bgMode === 0x1000000) {
        const bg = cell.getBgColor();
        if (bg < 8) sgr.push(40 + bg);
        else sgr.push(100 + bg - 8);
      } else if (bgMode === 0x2000000) {
        sgr.push(48, 5, cell.getBgColor());
      } else if (bgMode === 0x3000000) {
        const rgb = cell.getBgColor();
        const r = (rgb >> 16) & 0xFF;
        const g = (rgb >> 8) & 0xFF;
        const b = rgb & 0xFF;
        sgr.push(48, 2, r, g, b);
      }

      // Only emit SGR if changed from previous cell
      const sgrStr = sgr.join(';');
      if (sgrStr !== lastSgr) {
        if (sgr.length > 0) {
          result += `\x1b[0;${sgrStr}m`;
        } else if (lastSgr !== '') {
          result += '\x1b[0m';
        }
        lastSgr = sgrStr;
      }

      result += char;
    }

    // Reset at end of line if we had styling
    if (lastSgr !== '') {
      result += '\x1b[0m';
    }

    return result.replace(/\s+$/, '');  // Trim trailing whitespace
  }

  draw() {
    const buffer = this.term.buffer.active;
    const totalLines = this.contentHeight;
    const { height, width, offset } = this;
    const maxOffset = Math.max(0, totalLines - height);

    // Visual selection
    const inVisual = this.mode === 'visual' || this.mode === 'vline';
    const anchor = this.visualAnchor;
    const cursor = this.visualCursor;

    // Determine selection bounds
    let selStart, selEnd;
    if (inVisual) {
      if (anchor.line < cursor.line || (anchor.line === cursor.line && anchor.col <= cursor.col)) {
        selStart = anchor;
        selEnd = cursor;
      } else {
        selStart = cursor;
        selEnd = anchor;
      }
    }

    // Build visible lines
    const visible = [];
    for (let i = 0; i < height; i++) {
      const lineIdx = offset + i;
      let line = lineIdx < totalLines ? this.getLine(lineIdx) : '';
      const plainLine = lineIdx < totalLines ? this.getLineText(lineIdx) : '';

      if (this.mode === 'normal') {
        // NORMAL mode: show virtual cursor + search highlights
        if (this.search.matches.length > 0) {
          line = this.highlightSearchMatches(lineIdx, line, plainLine);
        }
        if (lineIdx === this.normalCursor.line) {
          line = this.insertCursorMarker(line, plainLine, this.normalCursor.col);
        }
      } else if (this.mode === 'insert') {
        // INSERT mode: only search highlights
        if (this.search.matches.length > 0) {
          line = this.highlightSearchMatches(lineIdx, line, plainLine);
        }
      } else if (this.mode === 'vline') {
        // V-LINE mode: use character-by-character highlighting (same as visual)
        const isSelected = lineIdx >= selStart.line && lineIdx <= selEnd.line;
        if (isSelected) {
          // Highlight entire line by setting hlStart=0 and hlEnd=line length
          const fullLineStart = { line: lineIdx, col: 0 };
          const fullLineEnd = { line: lineIdx, col: Math.max(0, plainLine.length - 1) };
          line = this.highlightVisualSelection(lineIdx, line, plainLine, fullLineStart, fullLineEnd, cursor);
        }
      } else if (this.mode === 'visual') {
        // VISUAL mode: character-level highlighting
        line = this.highlightVisualSelection(lineIdx, line, plainLine, selStart, selEnd, cursor);
      }

      visible.push(line);
    }

    // Status bar
    const from = totalLines ? offset + 1 : 0;
    const to = Math.min(offset + height, totalLines);
    const pctStr = offset <= 0 ? 'Top' : (offset >= maxOffset ? 'Bot' : `${Math.round(100 * offset / maxOffset)}%`);

    // Mode indicator
    const modeNames = { insert: 'INSERT', normal: 'NORMAL', visual: 'VISUAL', vline: 'V-LINE' };
    const modeStr = this.commandPending ? '[C-SPC]' : `[${modeNames[this.mode]}]`;

    // Search prompt or tips
    let leftPart;
    if (this.search.isActive) {
      leftPart = this.search.getStatus();
    } else {
      const scrollIndicator = this.followTail ? '' : '[SCROLL] ';
      const searchStatus = this.search.getStatus();
      let selInfo = '';
      if (this.mode === 'normal') {
        selInfo = `L${this.normalCursor.line + 1}:C${this.normalCursor.col + 1} `;
      } else if (inVisual && selStart && selEnd) {
        const lineCount = selEnd.line - selStart.line + 1;
        if (this.mode === 'vline') {
          selInfo = `${lineCount} line${lineCount > 1 ? 's' : ''} `;
        } else {
          selInfo = `L${cursor.line + 1}:C${cursor.col + 1} `;
        }
      }
      const tips = inVisual ? 'y:yank ' : '';
      leftPart = `${modeStr} ${selInfo}${scrollIndicator}${searchStatus ? searchStatus + ' ' : ''}${tips}Esc:exit`;
    }

    const pos = `[${from}-${to}/${totalLines}] ${pctStr}`;
    const status = ` ${leftPart}  ${pos} `;
    const statusPadded = status.length > width ? status.slice(-width) : status.padStart(width);

    // Render frame with sync update mode (DEC 2026) for flicker-free output
    let frame = '\x1b[?2026h';      // Begin sync update
    frame += '\x1b[?25l\x1b[H';     // Hide cursor, home
    for (let i = 0; i < visible.length; i++) {
      frame += `\x1b[${i + 1};1H\x1b[2K${visible[i]}`;
    }
    frame += `\x1b[${height + 1};1H\x1b[2K\x1b[7m${statusPadded}\x1b[0m`;
    frame += '\x1b[?25h';
    frame += '\x1b[?2026l';         // End sync update

    process.stdout.write(frame);
  }

  resize(cols, rows) {
    this.term.resize(cols, 1000);
    this.draw();
  }

  // Get plain text for a line (no ANSI codes)
  getLineText(index) {
    const buffer = this.term.buffer.active;
    if (index < 0 || index >= buffer.length) return '';
    const line = buffer.getLine(index);
    if (!line) return '';
    let result = '';
    for (let i = 0; i < line.length; i++) {
      const cell = line.getCell(i);
      if (!cell) break;
      const char = cell.getChars();
      if (char) result += char;
    }
    return result.replace(/\s+$/, '');
  }

  // Search delegation
  enterSearch() { this.search.enter(); }
  nextMatch() { this.search.next(); }
  prevMatch() { this.search.prev(); }

  // Highlight character-level visual selection
  highlightVisualSelection(lineIdx, line, plainLine, selStart, selEnd, cursor) {
    if (lineIdx < selStart.line || lineIdx > selEnd.line) {
      // Not in selection, but maybe show cursor
      if (lineIdx === cursor.line) {
        return this.insertCursorMarker(line, plainLine, cursor.col);
      }
      return line;
    }

    // Determine highlight range for this line
    let hlStart = 0;
    let hlEnd = plainLine.length;

    if (lineIdx === selStart.line) {
      hlStart = selStart.col;
    }
    if (lineIdx === selEnd.line) {
      hlEnd = selEnd.col + 1;
    }

    // Build highlighted line using plain text positions
    // Since line has ANSI codes, we work character by character
    let result = '';
    let plainIdx = 0;
    let i = 0;

    while (i < line.length) {
      // Check for ANSI escape sequence
      if (line[i] === '\x1b') {
        const escEnd = line.indexOf('m', i);
        if (escEnd !== -1) {
          result += line.substring(i, escEnd + 1);
          i = escEnd + 1;
          continue;
        }
      }

      // Regular character
      const char = line[i];
      const inHighlight = plainIdx >= hlStart && plainIdx < hlEnd;
      const isCursor = lineIdx === cursor.line && plainIdx === cursor.col;

      if (isCursor) {
        // Cursor: underline + inverse
        result += `\x1b[4;7m${char}\x1b[24;27m`;
      } else if (inHighlight) {
        // Selection: inverse
        result += `\x1b[7m${char}\x1b[27m`;
      } else {
        result += char;
      }

      plainIdx++;
      i++;
    }

    // If cursor is past end of line, show it
    if (lineIdx === cursor.line && cursor.col >= plainLine.length) {
      result += `\x1b[4;7m \x1b[24;27m`;
    }

    return result;
  }

  // Highlight search matches on a line
  highlightSearchMatches(lineIdx, line, plainLine) {
    const matches = this.search.matches.filter(m => m.line === lineIdx);
    if (matches.length === 0) return line;

    const currentMatch = this.search.matches[this.search.index];
    const isCurrentLine = currentMatch && currentMatch.line === lineIdx;

    let result = '';
    let plainIdx = 0;
    let i = 0;

    while (i < line.length) {
      // Skip ANSI escape sequences
      if (line[i] === '\x1b') {
        const escEnd = line.indexOf('m', i);
        if (escEnd !== -1) {
          result += line.substring(i, escEnd + 1);
          i = escEnd + 1;
          continue;
        }
      }

      // Check if this position is in a match
      let inMatch = false;
      let isCurrentMatchPos = false;
      for (const m of matches) {
        if (plainIdx >= m.col && plainIdx < m.col + m.length) {
          inMatch = true;
          if (isCurrentLine && currentMatch && m.col === currentMatch.col) {
            isCurrentMatchPos = true;
          }
          break;
        }
      }

      if (isCurrentMatchPos) {
        // Current match: bright yellow bg + black fg
        result += `\x1b[30;103m${line[i]}\x1b[0m`;
      } else if (inMatch) {
        // Other matches: yellow bg
        result += `\x1b[43m${line[i]}\x1b[49m`;
      } else {
        result += line[i];
      }

      plainIdx++;
      i++;
    }

    return result;
  }

  // Insert cursor marker at position (for lines not in selection)
  insertCursorMarker(line, plainLine, col) {
    let result = '';
    let plainIdx = 0;
    let i = 0;

    while (i < line.length) {
      if (line[i] === '\x1b') {
        const escEnd = line.indexOf('m', i);
        if (escEnd !== -1) {
          result += line.substring(i, escEnd + 1);
          i = escEnd + 1;
          continue;
        }
      }

      if (plainIdx === col) {
        result += `\x1b[4;7m${line[i]}\x1b[24;27m`;
      } else {
        result += line[i];
      }

      plainIdx++;
      i++;
    }

    if (col >= plainLine.length) {
      result += `\x1b[4;7m \x1b[24;27m`;
    }

    return result;
  }
}

// Cleanup
function cleanup() {
  process.stdout.write('\x1b[?1000l\x1b[?1006l');
  process.stdout.write('\x1b[?25h');
  process.stdout.write('\x1b[?1049l');
}

process.on('exit', cleanup);

// Delay startup to show splash
const SPLASH_DURATION = 2000;  // 2 seconds
const VIRTUAL_ROWS = parseInt(process.env.BUKOWSKI_ROWS) || (process.stdout.rows || 24);

setTimeout(() => {
  const vp = new Viewport();

  // Spawn Claude with large virtual terminal (matches xterm buffer)
  const claude = pty.spawn('node', [claudePath, ...process.argv.slice(2)], {
    name: 'xterm-256color',
    cols: process.stdout.columns || 80,
    rows: VIRTUAL_ROWS,
    cwd: process.cwd(),
    env: { ...process.env, FORCE_COLOR: '1' }
  });

  claude.onData(data => vp.push(data));

  // Input handling
  process.stdin.setRawMode(true);
  process.stdin.resume();

  process.stdin.on('data', (data) => {
    const str = data.toString();

    // Mouse (SGR: \x1b[<btn;x;yM)
    const mouseMatch = str.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (mouseMatch) {
      const btn = parseInt(mouseMatch[1]);
      if (mouseMatch[4] === 'M') {
        if (btn === 64) vp.scroll(-3);
        else if (btn === 65) vp.scroll(3);
      }
      return;
    }

    // Search mode input
    if (vp.search.isActive) {
      vp.search.handleKey(str);
      return;
    }

    // Ctrl+Space (0x00) triggers command mode
    if (str === '\x00') {
      vp.commandPending = true;
      vp.draw();
      return;
    }

    // Escape: cancel pending or return to insert mode
    if (str === '\x1b') {
      if (vp.commandPending) {
        vp.commandPending = false;
        vp.draw();
        return;
      }
      if (vp.mode !== 'insert') {
        vp.mode = 'insert';
        vp.vim.reset();
        vp.draw();
        return;
      }
      // Pass Escape to Claude in insert mode
      claude.write(data);
      return;
    }

    // Command pending - select mode
    if (vp.commandPending) {
      vp.commandPending = false;
      const wasInsert = vp.mode === 'insert';
      if (str === 'i') { vp.mode = 'insert'; vp.draw(); return; }
      if (str === 'n') {
        // Initialize normal cursor to Claude's cursor position
        const buffer = vp.term.buffer.active;
        vp.normalCursor.line = buffer.baseY + buffer.cursorY;
        vp.normalCursor.col = buffer.cursorX;
        vp.mode = 'normal';
        vp.vim.ensureLineVisible(vp.normalCursor.line);
        vp.draw();
        return;
      }
      if (str === 'v') { vp.vim.enterVisual('char', wasInsert ? 'insert' : vp.mode); return; }
      if (str === 'V') { vp.vim.enterVisual('line', wasInsert ? 'insert' : vp.mode); return; }
      vp.draw();
      return;
    }

    // Viewport keys (work in any mode)
    if (str === '\x1b[5~') { vp.scroll(-vp.height); return; }  // PgUp
    if (str === '\x1b[6~') { vp.scroll(vp.height); return; }   // PgDn
    if (str === '\x1b[1;5A') { vp.scroll(-1); return; }        // Ctrl+Up
    if (str === '\x1b[1;5B') { vp.scroll(1); return; }         // Ctrl+Down
    if (str === '\x0c') { vp.draw(); return; }                 // Ctrl+L

    // Normal/visual mode - handle vim keys
    if (vp.mode !== 'insert') {
      vp.vim.handleKey(str);
      return;
    }

    // Insert mode - pass to Claude
    claude.write(data);
  });

  // Mouse mode
  process.stdout.write('\x1b[?1000h\x1b[?1006h');

  // Resize - only change columns, keep virtual rows constant
  process.stdout.on('resize', () => {
    const cols = process.stdout.columns || 80;
    claude.resize(cols, VIRTUAL_ROWS);
    vp.resize(cols, VIRTUAL_ROWS);
  });

  // Signal handlers
  process.on('SIGINT', () => { cleanup(); claude.kill(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); claude.kill(); process.exit(0); });
  claude.onExit(({ exitCode }) => { cleanup(); process.exit(exitCode); });

}, SPLASH_DURATION);
