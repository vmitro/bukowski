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
    this.agentSessionId = config.agentSessionId || null;  // Agent's own session ID (for resume)

    this.pty = null;
    this.terminal = null;
    this.serializeAddon = null;
    this.status = 'stopped'; // 'stopped' | 'running' | 'error'
    this.socketPath = null;  // IPC socket path
    this.exitCode = null;
    this.spawnedAt = null;   // Timestamp when spawned (for session discovery)

    // Codex needs fake cursor (its cursor doesn't survive PTY), others render their own
    this.needsFakeCursor = config.needsFakeCursor ?? (this.type === 'codex');
  }

  spawn(cols = 80, rows = 24) {
    if (this.pty) this.kill();

    this.spawnedAt = Date.now();

    // Use pane height as virtual terminal size (agents adapt output to fit)
    // BUKOWSKI_ROWS env var can override for testing
    const virtualRows = parseInt(process.env.BUKOWSKI_ROWS) || rows;

    this.terminal = new Terminal({
      cols,
      rows: virtualRows,
      scrollback: parseInt(process.env.BUKOWSKI_SCROLLBACK) || 10000,
      allowProposedApi: true
    });
    this.serializeAddon = new SerializeAddon();
    this.terminal.loadAddon(this.serializeAddon);

    this.pty = pty.spawn(this.command, this.args, {
      name: 'xterm-256color',
      cols,
      rows: virtualRows,
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...this.env,
        FORCE_COLOR: '1',
        BUKOWSKI_AGENT_ID: this.id,    // For MCP bridge to use session agent ID
        BUKOWSKI_AGENT_TYPE: this.type // For MCP bridge to know agent type
      }
    });

    this.pty.onData(data => {
      this.terminal.write(data);

      // Handle cursor position request (DSR) - respond with current cursor position
      // Apps like Codex send \x1b[6n and expect \x1b[{row};{col}R back
      if (data.includes('\x1b[6n')) {
        const buffer = this.terminal.buffer.active;
        const row = buffer.cursorY + 1;
        const col = buffer.cursorX + 1;
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
    // Use pane height as virtual terminal size
    const virtualRows = parseInt(process.env.BUKOWSKI_ROWS) || rows;
    if (this.pty) this.pty.resize(cols, virtualRows);
    if (this.terminal) this.terminal.resize(cols, virtualRows);
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
    // Use buffer.length to include content below cursor (e.g., Codex status line)
    // buffer.length = baseY + number of visible rows with content
    return buffer.length;
  }

  getCursorPosition() {
    const buffer = this.getBuffer();
    if (!buffer) return null;
    return {
      line: buffer.baseY + buffer.cursorY,
      col: buffer.cursorX
    };
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
    // Strip resume args from saved config - we add them dynamically from agentSessionId
    let cleanArgs = [...this.args];

    // Claude: --resume <id> or -r <id>
    const resumeIdx = cleanArgs.findIndex(a => a === '--resume' || a === '-r');
    if (resumeIdx !== -1 && resumeIdx < cleanArgs.length - 1) {
      cleanArgs.splice(resumeIdx, 2);
    }

    // Codex: resume <id> as first arg
    if (cleanArgs[0] === 'resume' && cleanArgs.length > 1) {
      cleanArgs.splice(0, 2);
    }

    return {
      id: this.id,
      name: this.name,
      type: this.type,
      command: this.command,
      args: cleanArgs,
      env: this.env,
      autostart: this.autostart,
      agentSessionId: this.agentSessionId
    };
  }

  static fromJSON(data) {
    return new Agent(data);
  }
}

module.exports = { Agent };
