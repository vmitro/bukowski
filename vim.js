// vim.js - Vim mode handler for bukowski

class VimHandler {
  constructor(viewport) {
    this.vp = viewport;
    this.count = 0;
    this.pending = '';  // Multi-char command buffer (e.g., 'g' for gg)
  }

  // Handle a key in normal/visual mode. Returns true if handled.
  handleKey(key) {
    const vp = this.vp;

    // Count accumulation (1-9 start count, 0 only continues)
    if (key >= '1' && key <= '9') {
      this.count = this.count * 10 + parseInt(key);
      return true;
    }
    if (key === '0' && this.count > 0) {
      this.count = this.count * 10;
      return true;
    }

    const count = this.count || 1;
    this.count = 0;

    // Multi-char: gg
    if (this.pending === 'g') {
      this.pending = '';
      if (key === 'g') {
        if (vp.mode === 'visual' || vp.mode === 'vline') {
          vp.visualCursor.line = 0;
          vp.visualCursor.col = 0;
          this.ensureLineVisible(0);
        } else if (vp.mode === 'normal') {
          vp.normalCursor.line = 0;
          vp.normalCursor.col = 0;
          this.ensureLineVisible(0);
        } else {
          vp.offset = 0;
          vp.followTail = false;
        }
        vp.draw();
      }
      return true;
    }

    // Visual modes
    if (vp.mode === 'visual') {
      return this.handleVisualCharKey(key, count);
    }
    if (vp.mode === 'vline') {
      return this.handleVisualLineKey(key, count);
    }

    // Normal mode
    return this.handleNormalKey(key, count);
  }

  handleNormalKey(key, count) {
    const vp = this.vp;
    const cursor = vp.normalCursor;

    switch (key) {
      case 'j':
        cursor.line = Math.min(vp.contentHeight - 1, cursor.line + count);
        this.clampNormalCol();
        this.ensureLineVisible(cursor.line);
        vp.draw();
        return true;
      case 'k':
        cursor.line = Math.max(0, cursor.line - count);
        this.clampNormalCol();
        this.ensureLineVisible(cursor.line);
        vp.draw();
        return true;
      case 'h':
        cursor.col = Math.max(0, cursor.col - count);
        vp.draw();
        return true;
      case 'l':
        const lineLen = vp.getLineText(cursor.line).length;
        cursor.col = Math.min(Math.max(0, lineLen - 1), cursor.col + count);
        vp.draw();
        return true;
      case '0':
        cursor.col = 0;
        vp.draw();
        return true;
      case '$':
        cursor.col = Math.max(0, vp.getLineText(cursor.line).length - 1);
        vp.draw();
        return true;
      case '\x04':  // Ctrl+d
        cursor.line = Math.min(vp.contentHeight - 1, cursor.line + Math.floor(vp.height / 2));
        this.clampNormalCol();
        this.ensureLineVisible(cursor.line);
        vp.draw();
        return true;
      case '\x15':  // Ctrl+u
        cursor.line = Math.max(0, cursor.line - Math.floor(vp.height / 2));
        this.clampNormalCol();
        this.ensureLineVisible(cursor.line);
        vp.draw();
        return true;
      case '\x06':  // Ctrl+f
        cursor.line = Math.min(vp.contentHeight - 1, cursor.line + vp.height);
        this.clampNormalCol();
        this.ensureLineVisible(cursor.line);
        vp.draw();
        return true;
      case '\x02':  // Ctrl+b
        cursor.line = Math.max(0, cursor.line - vp.height);
        this.clampNormalCol();
        this.ensureLineVisible(cursor.line);
        vp.draw();
        return true;
      case 'g':
        this.pending = 'g';
        return true;
      case 'G':
        cursor.line = vp.contentHeight - 1;
        cursor.col = 0;
        this.ensureLineVisible(cursor.line);
        vp.draw();
        return true;
      case 'v':
        this.enterVisual('char');
        return true;
      case 'V':
        this.enterVisual('line');
        return true;
      case '/':
        vp.enterSearch();
        return true;
      case 'n':
        vp.nextMatch();
        return true;
      case 'N':
        vp.prevMatch();
        return true;
      default:
        return false;
    }
  }

  clampNormalCol() {
    const vp = this.vp;
    const lineLen = vp.getLineText(vp.normalCursor.line).length;
    vp.normalCursor.col = Math.min(vp.normalCursor.col, Math.max(0, lineLen - 1));
  }

  // Character-level visual mode (v)
  handleVisualCharKey(key, count) {
    const vp = this.vp;

    switch (key) {
      case 'j':
        vp.visualCursor.line = Math.min(vp.contentHeight - 1, vp.visualCursor.line + count);
        this.clampCursorCol();
        this.ensureLineVisible(vp.visualCursor.line);
        vp.draw();
        return true;
      case 'k':
        vp.visualCursor.line = Math.max(0, vp.visualCursor.line - count);
        this.clampCursorCol();
        this.ensureLineVisible(vp.visualCursor.line);
        vp.draw();
        return true;
      case 'h':
        vp.visualCursor.col = Math.max(0, vp.visualCursor.col - count);
        vp.draw();
        return true;
      case 'l':
        const lineLen = vp.getLineText(vp.visualCursor.line).length;
        vp.visualCursor.col = Math.min(lineLen - 1, vp.visualCursor.col + count);
        vp.draw();
        return true;
      case '0':
        vp.visualCursor.col = 0;
        vp.draw();
        return true;
      case '$':
        vp.visualCursor.col = Math.max(0, vp.getLineText(vp.visualCursor.line).length - 1);
        vp.draw();
        return true;
      case 'G':
        vp.visualCursor.line = vp.contentHeight - 1;
        this.clampCursorCol();
        this.ensureLineVisible(vp.visualCursor.line);
        vp.draw();
        return true;
      case 'g':
        this.pending = 'g';
        return true;
      case 'y':
        this.yankSelection();
        return true;
      case '\x1b':  // Escape - exit visual mode
        vp.mode = 'normal';
        vp.draw();
        return true;
      default:
        return false;
    }
  }

  // Line-level visual mode (V)
  handleVisualLineKey(key, count) {
    const vp = this.vp;

    switch (key) {
      case 'j':
        vp.visualCursor.line = Math.min(vp.contentHeight - 1, vp.visualCursor.line + count);
        this.ensureLineVisible(vp.visualCursor.line);
        vp.draw();
        return true;
      case 'k':
        vp.visualCursor.line = Math.max(0, vp.visualCursor.line - count);
        this.ensureLineVisible(vp.visualCursor.line);
        vp.draw();
        return true;
      case 'h':
      case 'l':
        // No-op in line mode
        return true;
      case 'G':
        vp.visualCursor.line = vp.contentHeight - 1;
        this.ensureLineVisible(vp.visualCursor.line);
        vp.draw();
        return true;
      case 'g':
        this.pending = 'g';
        return true;
      case 'y':
        this.yankSelection();
        return true;
      case '\x1b':  // Escape - exit visual mode
        vp.mode = 'normal';
        vp.draw();
        return true;
      default:
        return false;
    }
  }

  enterVisual(type, fromMode) {
    const vp = this.vp;
    const prevMode = fromMode || vp.mode;
    vp.mode = type === 'line' ? 'vline' : 'visual';

    let line, col;

    if (prevMode === 'normal') {
      // From normal mode: use virtual cursor
      line = vp.normalCursor.line;
      col = vp.normalCursor.col;
    } else {
      // From insert mode: use Claude's actual cursor position
      const buffer = vp.term.buffer.active;
      line = buffer.baseY + buffer.cursorY;
      col = buffer.cursorX;
    }

    vp.visualAnchor = { line, col };
    vp.visualCursor = { line, col };

    // Ensure cursor is visible
    this.ensureLineVisible(line);
    vp.draw();
  }

  clampCursorCol() {
    const vp = this.vp;
    const lineLen = vp.getLineText(vp.visualCursor.line).length;
    vp.visualCursor.col = Math.min(vp.visualCursor.col, Math.max(0, lineLen - 1));
  }

  ensureLineVisible(line) {
    const vp = this.vp;
    if (line < vp.offset) {
      vp.offset = line;
      vp.followTail = false;
    } else if (line >= vp.offset + vp.height) {
      vp.offset = line - vp.height + 1;
      vp.followTail = false;
    }
  }

  yankSelection() {
    const vp = this.vp;
    let text = '';

    if (vp.mode === 'vline') {
      // Line mode: yank full lines
      const startLine = Math.min(vp.visualAnchor.line, vp.visualCursor.line);
      const endLine = Math.max(vp.visualAnchor.line, vp.visualCursor.line);
      const lines = [];
      for (let i = startLine; i <= endLine; i++) {
        lines.push(vp.getLineText(i));
      }
      text = lines.join('\n');
    } else {
      // Character mode: yank from anchor to cursor
      const anchor = vp.visualAnchor;
      const cursor = vp.visualCursor;

      // Determine start and end positions
      let start, end;
      if (anchor.line < cursor.line || (anchor.line === cursor.line && anchor.col <= cursor.col)) {
        start = anchor;
        end = cursor;
      } else {
        start = cursor;
        end = anchor;
      }

      if (start.line === end.line) {
        // Single line
        const line = vp.getLineText(start.line);
        text = line.substring(start.col, end.col + 1);
      } else {
        // Multi-line
        const lines = [];
        // First line: from start.col to end
        lines.push(vp.getLineText(start.line).substring(start.col));
        // Middle lines: full
        for (let i = start.line + 1; i < end.line; i++) {
          lines.push(vp.getLineText(i));
        }
        // Last line: from start to end.col
        lines.push(vp.getLineText(end.line).substring(0, end.col + 1));
        text = lines.join('\n');
      }
    }

    // OSC 52 clipboard
    const b64 = Buffer.from(text).toString('base64');
    process.stdout.write(`\x1b]52;c;${b64}\x07`);

    // Return to insert mode for quick paste workflow
    vp.mode = 'insert';
    vp.draw();
  }

  // Reset state (e.g., on mode change)
  reset() {
    this.count = 0;
    this.pending = '';
  }
}

module.exports = { VimHandler };
