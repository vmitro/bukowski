// src/core/Agent.js - Agent class with PTY and terminal

const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

class Agent {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.type = config.type;
    this.command = config.command;
    this.args = config.args || [];
    this.env = config.env || {};
    this.autostart = config.autostart ?? false;

    this.pty = null;
    this.terminal = null;
    this.serializeAddon = null;
    this.status = 'stopped'; // 'stopped' | 'running' | 'error'
    this.socketPath = null;  // IPC socket path
    this.exitCode = null;
  }

  spawn(cols = 80, rows = 24) {
    if (this.pty) this.kill();

    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: 10000,
      allowProposedApi: true
    });
    this.serializeAddon = new SerializeAddon();
    this.terminal.loadAddon(this.serializeAddon);

    this.pty = pty.spawn(this.command, this.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.cwd(),
      env: { ...process.env, ...this.env, FORCE_COLOR: '1' }
    });

    this.pty.onData(data => {
      this.terminal.write(data);

      // Handle cursor position request (DSR) - respond with current cursor position
      // Codex and other apps send \x1b[6n and expect \x1b[{row};{col}R back
      if (data.includes('\x1b[6n')) {
        const buffer = this.terminal.buffer.active;
        const row = buffer.cursorY + 1;  // 1-indexed
        const col = buffer.cursorX + 1;  // 1-indexed
        this.pty.write(`\x1b[${row};${col}R`);
      }
    });
    this.pty.onExit(({ exitCode }) => {
      this.exitCode = exitCode;
      this.status = exitCode === 0 ? 'stopped' : 'error';
    });

    this.status = 'running';
  }

  kill() {
    if (this.pty) {
      this.pty.kill();
      this.pty = null;
    }
    this.status = 'stopped';
  }

  resize(cols, rows) {
    if (this.pty) this.pty.resize(cols, rows);
    if (this.terminal) this.terminal.resize(cols, rows);
  }

  write(data) {
    if (this.pty) this.pty.write(data);
  }

  getBuffer() {
    return this.terminal?.buffer?.active || null;
  }

  getContentHeight() {
    const buffer = this.getBuffer();
    if (!buffer) return 0;
    return buffer.baseY + buffer.cursorY + 1;
  }

  getLine(index) {
    const buffer = this.getBuffer();
    if (!buffer || index < 0 || index >= buffer.length) return '';

    const line = buffer.getLine(index);
    if (!line) return '';

    // First pass: find last non-default cell (has styling or non-space char)
    let lastStyledIdx = -1;
    for (let i = 0; i < line.length; i++) {
      const cell = line.getCell(i);
      if (!cell) break;

      const char = cell.getChars();
      const hasBg = cell.getBgColorMode() !== 0;
      const hasFg = cell.getFgColorMode() !== 0;
      const hasAttrs = cell.isBold() || cell.isDim() || cell.isItalic() ||
                       cell.isUnderline() || cell.isBlink() || cell.isInverse() ||
                       cell.isInvisible() || cell.isStrikethrough();

      // Keep this cell if it has content OR has any styling
      if (char || hasBg || hasFg || hasAttrs) {
        lastStyledIdx = i;
      }
    }

    if (lastStyledIdx < 0) return '';

    let result = '';
    let lastSgr = '';

    for (let i = 0; i <= lastStyledIdx; i++) {
      const cell = line.getCell(i);
      if (!cell) break;

      const char = cell.getChars() || ' ';  // Empty cells are spaces

      let sgr = [];

      if (cell.isBold()) sgr.push(1);
      if (cell.isDim()) sgr.push(2);
      if (cell.isItalic()) sgr.push(3);
      if (cell.isUnderline()) sgr.push(4);
      if (cell.isBlink()) sgr.push(5);
      if (cell.isInverse()) sgr.push(7);
      if (cell.isInvisible()) sgr.push(8);
      if (cell.isStrikethrough()) sgr.push(9);

      const fgMode = cell.getFgColorMode();
      // Fg color modes: 0 = default, 0x1000000 = 16-color,
      // 0x2000000 = 256-color, 0x3000000 = RGB
      if (fgMode === 0x1000000) {
        const fg = cell.getFgColor();
        if (fg < 8) sgr.push(30 + fg);
        else sgr.push(90 + fg - 8);
      } else if (fgMode === 0x2000000) {
        sgr.push(38, 5, cell.getFgColor());
      } else if (fgMode === 0x3000000) {
        const rgb = cell.getFgColor();
        const r = (rgb >> 16) & 0xFF;
        const g = (rgb >> 8) & 0xFF;
        const b = rgb & 0xFF;
        sgr.push(38, 2, r, g, b);
      }

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

    if (lastSgr !== '') {
      result += '\x1b[0m';
    }

    return result;
  }

  getLineText(index) {
    const buffer = this.getBuffer();
    if (!buffer || index < 0 || index >= buffer.length) return '';
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

  getVisibleLines(startRow, count) {
    const lines = [];
    for (let i = 0; i < count; i++) {
      lines.push(this.getLine(startRow + i));
    }
    return lines;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      command: this.command,
      args: this.args,
      env: this.env,
      autostart: this.autostart
    };
  }

  static fromJSON(data) {
    return new Agent(data);
  }
}

module.exports = { Agent };
