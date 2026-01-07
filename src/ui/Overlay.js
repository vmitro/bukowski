// src/ui/Overlay.js - Base overlay class with auto-resize
// Terminal "blitting" - draw rectangles at absolute positions

const EventEmitter = require('events');

// Box drawing characters
const BOX = {
  TL: '┌', TR: '┐', BL: '└', BR: '┘',
  H: '─', V: '│',
  LT: '├', RT: '┤', TT: '┬', BT: '┴', X: '┼'
};

// ANSI codes
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const REVERSE = '\x1b[7m';
const BG_DARK = '\x1b[48;5;236m';
const BG_DARKER = '\x1b[48;5;234m';
const FG_WHITE = '\x1b[97m';
const FG_GRAY = '\x1b[90m';
const FG_CYAN = '\x1b[36m';

/**
 * Overlay
 *
 * Base class for modal UI elements drawn on top of pane content.
 * Supports auto-resizing input areas with soft text wrapping.
 *
 * Subclasses override render() for custom layouts.
 */
class Overlay extends EventEmitter {
  constructor(config) {
    super();

    this.id = config.id;
    this.type = config.type || 'generic';
    this.title = config.title || '';

    // Bounds (0-indexed terminal coordinates)
    this.bounds = {
      x: config.x || 0,
      y: config.y || 0,
      width: config.width || 50,
      height: config.height || 10
    };

    // Size constraints
    this.minWidth = config.minWidth || 20;
    this.maxWidth = config.maxWidth || 80;
    this.minHeight = config.minHeight || 3;
    this.maxHeight = config.maxHeight || 20;

    // Input buffer and wrapped lines
    this.inputBuffer = config.content || '';
    this.wrappedLines = [];
    this.cursorPos = this.inputBuffer.length;
    this.scrollOffset = 0;

    // Focus state
    this.focused = true;

    // Rewrap initial content
    this._rewrap();
  }

  /**
   * Get content width (inside borders/padding)
   * @returns {number}
   */
  getContentWidth() {
    return this.bounds.width - 4; // 2 for borders, 2 for padding
  }

  /**
   * Get content height (inside borders/header/footer)
   * @returns {number}
   */
  getContentHeight() {
    return this.bounds.height - 2; // 1 header + 1 footer
  }

  /**
   * Add a character to input buffer
   * @param {string} char
   */
  addChar(char) {
    // Insert at cursor position
    this.inputBuffer =
      this.inputBuffer.slice(0, this.cursorPos) +
      char +
      this.inputBuffer.slice(this.cursorPos);
    this.cursorPos++;

    this._rewrap();
    this._maybeGrow();
    this._ensureCursorVisible();
  }

  /**
   * Delete character before cursor
   */
  backspace() {
    if (this.cursorPos > 0) {
      this.inputBuffer =
        this.inputBuffer.slice(0, this.cursorPos - 1) +
        this.inputBuffer.slice(this.cursorPos);
      this.cursorPos--;
      this._rewrap();
      this._maybeShrink();
    }
  }

  /**
   * Delete word before cursor
   */
  deleteWord() {
    const before = this.inputBuffer.slice(0, this.cursorPos);
    const after = this.inputBuffer.slice(this.cursorPos);

    // Remove trailing whitespace, then word
    const trimmed = before.replace(/\S*\s*$/, '');
    this.inputBuffer = trimmed + after;
    this.cursorPos = trimmed.length;

    this._rewrap();
    this._maybeShrink();
  }

  /**
   * Clear all input
   */
  clear() {
    this.inputBuffer = '';
    this.cursorPos = 0;
    this._rewrap();
    this._maybeShrink();
  }

  /**
   * Move cursor left
   */
  cursorLeft() {
    if (this.cursorPos > 0) {
      this.cursorPos--;
      this._ensureCursorVisible();
    }
  }

  /**
   * Move cursor right
   */
  cursorRight() {
    if (this.cursorPos < this.inputBuffer.length) {
      this.cursorPos++;
      this._ensureCursorVisible();
    }
  }

  /**
   * Move cursor to start
   */
  cursorHome() {
    this.cursorPos = 0;
    this._ensureCursorVisible();
  }

  /**
   * Move cursor to end
   */
  cursorEnd() {
    this.cursorPos = this.inputBuffer.length;
    this._ensureCursorVisible();
  }

  /**
   * Soft-wrap input buffer into lines
   * @private
   */
  _rewrap() {
    const width = this.getContentWidth();
    this.wrappedLines = [];

    if (!this.inputBuffer) {
      this.wrappedLines = [''];
      return;
    }

    // Simple character-based wrapping (preserves words when possible)
    let currentLine = '';
    const words = this.inputBuffer.split(/(\s+)/);

    for (const word of words) {
      if (currentLine.length + word.length <= width) {
        currentLine += word;
      } else if (word.length > width) {
        // Word is longer than width - break it
        if (currentLine) {
          this.wrappedLines.push(currentLine);
          currentLine = '';
        }
        for (let i = 0; i < word.length; i += width) {
          const chunk = word.slice(i, i + width);
          if (chunk.length === width) {
            this.wrappedLines.push(chunk);
          } else {
            currentLine = chunk;
          }
        }
      } else {
        // Start new line
        if (currentLine) {
          this.wrappedLines.push(currentLine);
        }
        currentLine = word.trimStart();
      }
    }

    if (currentLine || this.wrappedLines.length === 0) {
      this.wrappedLines.push(currentLine);
    }
  }

  /**
   * Grow overlay height if needed
   * @private
   */
  _maybeGrow() {
    const neededHeight = this.wrappedLines.length + 2; // + header + footer
    if (neededHeight > this.bounds.height && neededHeight <= this.maxHeight) {
      this.bounds.height = neededHeight;
      this.emit('resize');
    }
  }

  /**
   * Shrink overlay height if possible
   * @private
   */
  _maybeShrink() {
    const neededHeight = Math.max(this.minHeight, this.wrappedLines.length + 2);
    if (neededHeight < this.bounds.height) {
      this.bounds.height = neededHeight;
      this.emit('resize');
    }
  }

  /**
   * Ensure cursor line is visible (scroll if needed)
   * @private
   */
  _ensureCursorVisible() {
    const cursorLine = this._getCursorLine();
    const visibleLines = this.getContentHeight();

    if (cursorLine < this.scrollOffset) {
      this.scrollOffset = cursorLine;
    } else if (cursorLine >= this.scrollOffset + visibleLines) {
      this.scrollOffset = cursorLine - visibleLines + 1;
    }
  }

  /**
   * Get which wrapped line the cursor is on
   * @private
   * @returns {number}
   */
  _getCursorLine() {
    let charCount = 0;
    for (let i = 0; i < this.wrappedLines.length; i++) {
      charCount += this.wrappedLines[i].length;
      if (charCount >= this.cursorPos) {
        return i;
      }
    }
    return this.wrappedLines.length - 1;
  }

  /**
   * Get cursor column within its line
   * @private
   * @returns {number}
   */
  _getCursorCol() {
    let charCount = 0;
    for (let i = 0; i < this.wrappedLines.length; i++) {
      const lineLen = this.wrappedLines[i].length;
      if (charCount + lineLen >= this.cursorPos) {
        return this.cursorPos - charCount;
      }
      charCount += lineLen;
    }
    return 0;
  }

  /**
   * Handle input key/sequence
   * @param {string} data
   * @returns {Object} - Action result
   */
  handleInput(data) {
    // ESC - cancel/close
    if (data === '\x1b') {
      return { action: 'overlay_cancel' };
    }

    // Enter - submit
    if (data === '\r' || data === '\n') {
      return { action: 'overlay_submit', content: this.inputBuffer };
    }

    // Backspace
    if (data === '\x7f' || data === '\b') {
      this.backspace();
      return { action: 'overlay_update' };
    }

    // Ctrl+W - delete word
    if (data === '\x17') {
      this.deleteWord();
      return { action: 'overlay_update' };
    }

    // Ctrl+U - clear
    if (data === '\x15') {
      this.clear();
      return { action: 'overlay_update' };
    }

    // Arrow keys
    if (data === '\x1b[D') {  // Left
      this.cursorLeft();
      return { action: 'overlay_update' };
    }
    if (data === '\x1b[C') {  // Right
      this.cursorRight();
      return { action: 'overlay_update' };
    }

    // Home/End
    if (data === '\x1b[H' || data === '\x01') {  // Home or Ctrl+A
      this.cursorHome();
      return { action: 'overlay_update' };
    }
    if (data === '\x1b[F' || data === '\x05') {  // End or Ctrl+E
      this.cursorEnd();
      return { action: 'overlay_update' };
    }

    // Printable character
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.addChar(data);
      return { action: 'overlay_update' };
    }

    // Unknown - return for subclass handling
    return { action: 'overlay_unknown', key: data };
  }

  /**
   * Render the overlay to positioned line strings
   * Override in subclasses for custom layouts
   * @returns {Array<{row: number, col: number, content: string}>}
   */
  render() {
    const lines = [];
    const { x, y, width, height } = this.bounds;
    const contentWidth = this.getContentWidth();

    // Header row - ensure exact width
    lines.push({
      row: y,
      col: x,
      content: this._ensureLineWidth(this._renderHeader(), width)
    });

    // Content rows - ensure exact width
    const visibleLines = this.getContentHeight();
    for (let i = 0; i < visibleLines; i++) {
      const lineIdx = this.scrollOffset + i;
      lines.push({
        row: y + 1 + i,
        col: x,
        content: this._ensureLineWidth(this._renderContentLine(lineIdx, i === visibleLines - 1), width)
      });
    }

    // Footer row - ensure exact width
    lines.push({
      row: y + height - 1,
      col: x,
      content: this._ensureLineWidth(this._renderFooter(), width)
    });

    return lines;
  }

  /**
   * Ensure a line has exactly the specified visual width
   * @private
   */
  _ensureLineWidth(line, width) {
    // Count visible characters (ignoring ANSI codes)
    let visibleLen = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\x1b') {
        const escEnd = line.indexOf('m', i);
        if (escEnd !== -1) {
          i = escEnd;
          continue;
        }
      }
      visibleLen++;
    }

    // Pad if too short
    if (visibleLen < width) {
      // Remove trailing RESET if present, add padding, then add RESET
      const withoutReset = line.replace(/\x1b\[0m$/, '');
      return withoutReset + ' '.repeat(width - visibleLen) + RESET;
    }

    // Truncate if too long (preserving ANSI codes)
    if (visibleLen > width) {
      let result = '';
      let count = 0;
      for (let i = 0; i < line.length && count < width; i++) {
        if (line[i] === '\x1b') {
          const escEnd = line.indexOf('m', i);
          if (escEnd !== -1) {
            result += line.substring(i, escEnd + 1);
            i = escEnd;
            continue;
          }
        }
        result += line[i];
        count++;
      }
      return result + RESET;
    }

    return line;
  }

  /**
   * Render header line
   * @private
   */
  _renderHeader() {
    const width = this.bounds.width;
    const title = this.title ? ` ${this.title} ` : '';
    const padding = width - title.length - 2;

    return `${BG_DARK}${FG_WHITE}${BOX.TL}${BOX.H}${BOLD}${title}${RESET}${BG_DARK}${FG_WHITE}${BOX.H.repeat(Math.max(0, padding))}${BOX.TR}${RESET}`;
  }

  /**
   * Render a content line
   * @private
   */
  _renderContentLine(lineIdx, isLastVisible) {
    const width = this.bounds.width;
    const contentWidth = this.getContentWidth();
    // Strip any ANSI codes from the line to prevent color bleeding
    const rawLine = this.wrappedLines[lineIdx] || '';
    const line = rawLine.replace(/\x1b\[[0-9;]*m/g, '');

    // Determine cursor position on this line
    const cursorLine = this._getCursorLine();
    const cursorCol = this._getCursorCol();
    const hasCursor = this.focused && lineIdx === cursorLine;

    // Build content string, padding to exact contentWidth
    let visibleContent = line.padEnd(contentWidth, ' ').substring(0, contentWidth);

    // If cursor is on this line, add cursor highlighting
    let lineContent;
    if (hasCursor) {
      const col = Math.min(cursorCol, contentWidth - 1);
      const before = visibleContent.substring(0, col);
      const cursorChar = visibleContent[col] || ' ';
      const after = visibleContent.substring(col + 1);
      // Ensure 'after' is padded to fill remaining space
      const afterPadded = after.padEnd(contentWidth - col - 1, ' ');
      lineContent = `${before}${REVERSE}${cursorChar}${RESET}${BG_DARKER}${FG_WHITE}${afterPadded}`;
    } else {
      lineContent = visibleContent;
    }

    // Build complete line: border + space + content + space + border
    // Use explicit character-by-character construction to ensure exact width
    // Structure: │ + space + contentWidth chars + space + │ = width chars
    return `${BG_DARKER}${FG_WHITE}${BOX.V} ${lineContent} ${BOX.V}${RESET}`;
  }

  /**
   * Render footer line
   * @private
   */
  _renderFooter() {
    const width = this.bounds.width;
    const hint = ' Enter:submit Esc:cancel ';
    const padding = width - hint.length - 2;

    return `${BG_DARK}${FG_GRAY}${BOX.BL}${BOX.H.repeat(Math.max(0, padding))}${hint}${BOX.BR}${RESET}`;
  }
}

/**
 * Factory function to create overlay by type
 * @param {Object} config
 * @returns {Overlay}
 */
function createOverlay(config) {
  // Import specialized overlays here to avoid circular deps
  switch (config.type) {
    case 'acl-input': {
      const { ACLInputOverlay } = require('./ACLInputOverlay');
      return new ACLInputOverlay(config);
    }
    case 'agent-picker': {
      const { AgentPickerOverlay } = require('./AgentPickerOverlay');
      return new AgentPickerOverlay(config);
    }
    case 'conversation-picker': {
      const { ConversationPicker } = require('./ConversationPicker');
      return new ConversationPicker(config);
    }
    default:
      return new Overlay(config);
  }
}

module.exports = {
  Overlay,
  createOverlay,
  BOX,
  // Export ANSI constants for subclasses
  RESET, DIM, BOLD, REVERSE,
  BG_DARK, BG_DARKER,
  FG_WHITE, FG_GRAY, FG_CYAN
};
