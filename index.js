#!/usr/bin/env node
// bukowski - flicker-free terminal viewport for Ink-based CLI apps

const path = require('path');
const { execSync } = require('child_process');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

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
    const rows = parseInt(process.env.BUKOWSKI_ROWS) || 500;  // Virtual terminal height

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

    // Build visible lines
    const visible = [];
    for (let i = 0; i < height; i++) {
      const lineIdx = offset + i;
      visible.push(lineIdx < totalLines ? this.getLine(lineIdx) : '');
    }

    // Status bar
    const from = totalLines ? offset + 1 : 0;
    const to = Math.min(offset + height, totalLines);
    const pctStr = offset <= 0 ? 'Top' : (offset >= maxOffset ? 'Bot' : `${Math.round(100 * offset / maxOffset)}%`);
    const scrollIndicator = this.followTail ? '' : '[SCROLL] ';
    const tips = 'Shift+click:select | PgUp/PgDn:scroll';
    const pos = `[${from}-${to}/${totalLines}] ${pctStr}`;
    const status = ` ${scrollIndicator}${tips}  ${pos} `;
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
const VIRTUAL_ROWS = parseInt(process.env.BUKOWSKI_ROWS) || 500;

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

    // Viewport keys
    if (str === '\x1b[5~') { vp.scroll(-vp.height); return; }  // PgUp
    if (str === '\x1b[6~') { vp.scroll(vp.height); return; }   // PgDn
    if (str === '\x1b[1;5A') { vp.scroll(-1); return; }        // Ctrl+Up
    if (str === '\x1b[1;5B') { vp.scroll(1); return; }         // Ctrl+Down
    if (str === '\x0c') { vp.draw(); return; }                 // Ctrl+L

    // Pass to Claude
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
