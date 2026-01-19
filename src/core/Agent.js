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

    // Line cache: invalidated on terminal writes
    this._lineCache = new Map();  // lineIndex -> { str, gen }
    this._cacheGen = 0;           // Increments on each terminal write

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
      scrollback: parseInt(process.env.BUKOWSKI_SCROLLBACK) || 50000,
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
        BUKOWSKI_AGENT_TYPE: this.type, // For MCP bridge to know agent type
        BUKOWSKI_MCP_SOCKET: process.env.BUKOWSKI_MCP_SOCKET // Inherit parent's socket path
      }
    });

    this.pty.onData(data => {
      this.terminal.write(data);
      this._cacheGen++;  // Invalidate line cache

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

    // Check cache first
    const cached = this._lineCache.get(index);
    if (cached && cached.gen === this._cacheGen) {
      return cached.str;
    }

    const line = buffer.getLine(index);
    if (!line) return '';

    // OPTIMIZED: Single pass, collect cells then build string
    const lineLen = line.length;
    const cells = [];
    let lastContentIdx = -1;

    // Single pass: collect cell data and track last content position
    for (let i = 0; i < lineLen; i++) {
      const cell = line.getCell(i);
      if (!cell) break;

      const char = cell.getChars();
      const fgMode = cell.getFgColorMode();
      const bgMode = cell.getBgColorMode();

      // Check if cell has content or styling (combine checks for speed)
      const hasContent = char || fgMode !== 0 || bgMode !== 0 ||
        cell.isBold() || cell.isDim() || cell.isItalic() ||
        cell.isUnderline() || cell.isInverse() || cell.isStrikethrough();

      if (hasContent) lastContentIdx = i;

      cells.push({
        char: char || ' ',
        fgMode,
        bgMode,
        fg: fgMode ? cell.getFgColor() : 0,
        bg: bgMode ? cell.getBgColor() : 0,
        bold: cell.isBold(),
        dim: cell.isDim(),
        italic: cell.isItalic(),
        underline: cell.isUnderline(),
        inverse: cell.isInverse(),
        strikethrough: cell.isStrikethrough()
      });
    }

    if (lastContentIdx < 0) {
      this._lineCache.set(index, { str: '', gen: this._cacheGen });
      return '';
    }

    // Build result with array.join (faster than += for many concatenations)
    const parts = [];
    let lastSgr = '';

    for (let i = 0; i <= lastContentIdx; i++) {
      const c = cells[i];
      const sgr = [];

      if (c.bold) sgr.push(1);
      if (c.dim) sgr.push(2);
      if (c.italic) sgr.push(3);
      if (c.underline) sgr.push(4);
      if (c.inverse) sgr.push(7);
      if (c.strikethrough) sgr.push(9);

      // Foreground color
      if (c.fgMode === 0x1000000) {
        sgr.push(c.fg < 8 ? 30 + c.fg : 82 + c.fg);
      } else if (c.fgMode === 0x2000000) {
        sgr.push(38, 5, c.fg);
      } else if (c.fgMode === 0x3000000) {
        sgr.push(38, 2, (c.fg >> 16) & 0xFF, (c.fg >> 8) & 0xFF, c.fg & 0xFF);
      }

      // Background color
      if (c.bgMode === 0x1000000) {
        sgr.push(c.bg < 8 ? 40 + c.bg : 92 + c.bg);
      } else if (c.bgMode === 0x2000000) {
        sgr.push(48, 5, c.bg);
      } else if (c.bgMode === 0x3000000) {
        sgr.push(48, 2, (c.bg >> 16) & 0xFF, (c.bg >> 8) & 0xFF, c.bg & 0xFF);
      }

      const sgrStr = sgr.length ? sgr.join(';') : '';
      if (sgrStr !== lastSgr) {
        parts.push(sgrStr ? `\x1b[0;${sgrStr}m` : (lastSgr ? '\x1b[0m' : ''));
        lastSgr = sgrStr;
      }

      parts.push(c.char);
    }

    if (lastSgr) parts.push('\x1b[0m');

    const result = parts.join('');
    this._lineCache.set(index, { str: result, gen: this._cacheGen });
    return result;
  }

  getLineText(index) {
    const buffer = this.getBuffer();
    if (!buffer || index < 0 || index >= buffer.length) return '';
    const line = buffer.getLine(index);
    if (!line) return '';

    // OPTIMIZED: array.join() + trimEnd() instead of += and regex
    const chars = [];
    for (let i = 0; i < line.length; i++) {
      const cell = line.getCell(i);
      if (!cell) break;
      const char = cell.getChars();
      if (char) chars.push(char);
    }
    return chars.join('').trimEnd();
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
