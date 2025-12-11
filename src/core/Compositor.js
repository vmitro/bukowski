// src/core/Compositor.js - Multi-viewport rendering compositor

class Compositor {
  constructor(session, layoutManager, tabBar) {
    this.session = session;
    this.layoutManager = layoutManager;
    this.tabBar = tabBar;
    this.cols = 80;
    this.rows = 24;
    this.frame = null;       // 2D array of { char, fg, bg, attrs }
    this.scrollOffsets = new Map(); // paneId -> scrollY
    this.followTail = new Map();    // paneId -> boolean (whether to auto-scroll)
    this.searchState = null; // Will be set from multi.js
    this.visualState = null; // Will be set from multi.js - {mode, visualAnchor, visualCursor}
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    // Recalculate layout bounds
    // Reserve: 1 row for tab bar, 1 row for status bar
    this.layoutManager.calculateBounds(0, 1, cols, rows - 2);
  }

  /**
   * Create empty frame buffer
   */
  createFrame() {
    const frame = [];
    for (let y = 0; y < this.rows; y++) {
      const row = [];
      for (let x = 0; x < this.cols; x++) {
        row.push({ char: ' ', fg: null, bg: null, attrs: 0 });
      }
      frame.push(row);
    }
    return frame;
  }

  /**
   * Write string to frame at position
   */
  writeToFrame(frame, x, y, str) {
    if (y < 0 || y >= this.rows) return;

    let col = x;
    let i = 0;

    while (i < str.length && col < this.cols) {
      // Skip ANSI escape sequences
      if (str[i] === '\x1b' && str[i + 1] === '[') {
        let j = i + 2;
        while (j < str.length && !/[A-Za-z]/.test(str[j])) j++;
        i = j + 1;
        continue;
      }

      if (col >= 0) {
        frame[y][col].char = str[i];
      }
      col++;
      i++;
    }
  }

  /**
   * Write raw string with ANSI codes preserved
   * @param {number} maxWidth - Optional max width to write (for pane boundaries)
   */
  writeRawToFrame(frame, x, y, str, maxWidth = null) {
    if (y < 0 || y >= this.rows) return x;

    const maxCol = maxWidth !== null ? x + maxWidth : this.cols;
    let col = x;
    let i = 0;
    let currentFg = null;
    let currentBg = null;
    let currentAttrs = 0;

    while (i < str.length) {
      // Stop if we've reached the max column
      if (col >= maxCol) break;

      // Parse ANSI escape sequences
      if (str[i] === '\x1b' && str[i + 1] === '[') {
        let j = i + 2;
        let params = '';
        while (j < str.length && !/[A-Za-z]/.test(str[j])) {
          params += str[j];
          j++;
        }
        const cmd = str[j];

        if (cmd === 'm') {
          const codes = params.split(';').map(n => parseInt(n, 10) || 0);
          this.applySGR(codes, (fg, bg, attrs) => {
            currentFg = fg;
            currentBg = bg;
            currentAttrs = attrs;
          }, currentFg, currentBg, currentAttrs);
        }

        i = j + 1;
        continue;
      }

      if (col >= 0 && col < this.cols) {
        frame[y][col].char = str[i];
        frame[y][col].fg = currentFg;
        frame[y][col].bg = currentBg;
        frame[y][col].attrs = currentAttrs;
      }
      col++;
      i++;
    }

    return col;
  }

  /**
   * Apply SGR codes to style state
   */
  applySGR(codes, setter, fg, bg, attrs) {
    let i = 0;
    while (i < codes.length) {
      const c = codes[i];

      if (c === 0) {
        fg = null;
        bg = null;
        attrs = 0;
      } else if (c === 1) {
        attrs |= 1; // Bold
      } else if (c === 2) {
        attrs |= 2; // Dim
      } else if (c === 3) {
        attrs |= 4; // Italic
      } else if (c === 4) {
        attrs |= 8; // Underline
      } else if (c === 7) {
        attrs |= 16; // Inverse
      } else if (c === 9) {
        attrs |= 32; // Strikethrough
      } else if (c >= 30 && c <= 37) {
        fg = c - 30;
      } else if (c >= 90 && c <= 97) {
        fg = c - 90 + 8;
      } else if (c === 38) {
        if (codes[i + 1] === 5) {
          fg = { type: '256', value: codes[i + 2] };
          i += 2;
        } else if (codes[i + 1] === 2) {
          fg = { type: 'rgb', r: codes[i + 2], g: codes[i + 3], b: codes[i + 4] };
          i += 4;
        }
      } else if (c >= 40 && c <= 47) {
        bg = c - 40;
      } else if (c >= 100 && c <= 107) {
        bg = c - 100 + 8;
      } else if (c === 48) {
        if (codes[i + 1] === 5) {
          bg = { type: '256', value: codes[i + 2] };
          i += 2;
        } else if (codes[i + 1] === 2) {
          bg = { type: 'rgb', r: codes[i + 2], g: codes[i + 3], b: codes[i + 4] };
          i += 4;
        }
      }
      i++;
    }

    setter(fg, bg, attrs);
  }

  /**
   * Main render function - builds complete frame
   */
  render() {
    this.frame = this.createFrame();

    // Render components
    this.renderTabBar(this.frame);
    this.renderPanes(this.frame);
    this.renderBorders(this.frame);
    this.renderStatusBar(this.frame);

    return this.frame;
  }

  /**
   * Render tab bar (row 0)
   */
  renderTabBar(frame) {
    const agents = this.session.getAllAgents();
    const focusedPane = this.layoutManager.getFocusedPane();

    const tabs = agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      active: focusedPane?.agentId === agent.id,
      status: agent.status
    }));

    this.tabBar.setTabs(tabs);
    const tabBarStr = this.tabBar.render(this.cols);

    // Write tab bar with styling
    this.writeRawToFrame(frame, 0, 0, tabBarStr);
  }

  /**
   * Render all visible panes
   */
  renderPanes(frame) {
    const panes = this.layoutManager.getAllPanes();

    for (const pane of panes) {
      this.renderPane(frame, pane);
    }
  }

  /**
   * Render single pane content
   */
  renderPane(frame, pane) {
    const agent = this.session.getAgent(pane.agentId);
    if (!agent) return;

    const { x, y, width, height } = pane.bounds;
    const isFocused = pane.id === this.layoutManager.focusedPaneId;

    // Get scroll offset for this pane
    let scrollY = this.scrollOffsets.get(pane.id) || 0;
    const contentHeight = agent.getContentHeight();
    const maxScroll = Math.max(0, contentHeight - height);

    // Auto-scroll to follow output if followTail is true (default: true for new panes)
    if (this.followTail.get(pane.id) !== false) {
      scrollY = maxScroll;
      this.scrollOffsets.set(pane.id, scrollY);
    }

    // Render visible lines
    for (let row = 0; row < height; row++) {
      const bufferLine = scrollY + row;
      const screenY = y + row;

      if (screenY >= this.rows - 1) break; // Leave room for status bar

      let lineContent = agent.getLine(bufferLine);
      if (lineContent) {
        // Apply search highlighting if this is the focused pane and we have matches
        if (isFocused && this.searchState && this.searchState.matches.length > 0) {
          const lineMatches = this.searchState.matches.filter(m => m.line === bufferLine);
          if (lineMatches.length > 0) {
            const plainLine = agent.getLineText(bufferLine);
            lineContent = this.highlightSearchMatches(lineContent, plainLine, lineMatches, bufferLine);
          }
        }

        // Apply visual selection highlighting if this is the focused pane and we're in visual mode
        if (isFocused && this.visualState &&
            (this.visualState.mode === 'visual' || this.visualState.mode === 'vline')) {
          const selRange = this.getSelectionRangeOnLine(bufferLine, agent);
          if (selRange) {
            const plainLine = agent.getLineText(bufferLine);
            lineContent = this.highlightVisualSelection(lineContent, plainLine, selRange, bufferLine);
          }
        }

        // Apply normal mode cursor if this is the focused pane and we're in normal mode
        const mode = this.inputRouter?.mode;
        if (isFocused && mode === 'normal' && this.visualState?.normalCursor) {
          if (bufferLine === this.visualState.normalCursor.line) {
            const plainLine = agent.getLineText(bufferLine);
            lineContent = this.highlightNormalCursor(lineContent, plainLine, this.visualState.normalCursor.col);
          }
        }

        this.writeRawToFrame(frame, x, screenY, lineContent, width);
      }
    }
  }

  /**
   * Highlight search matches in a line
   * @param {string} styledLine - Line with ANSI codes
   * @param {string} plainLine - Plain text line
   * @param {Array} matches - Matches on this line [{col, length}, ...]
   * @param {number} lineIdx - Line index for checking current match
   * @returns {string} Line with search highlights applied
   */
  highlightSearchMatches(styledLine, plainLine, matches, lineIdx) {
    const currentMatch = this.searchState.matches[this.searchState.index];
    const isCurrentLine = currentMatch && currentMatch.line === lineIdx;

    let result = '';
    let plainIdx = 0;
    let i = 0;

    while (i < styledLine.length) {
      // Skip ANSI escape sequences
      if (styledLine[i] === '\x1b' && styledLine[i + 1] === '[') {
        const escEnd = styledLine.indexOf('m', i);
        if (escEnd !== -1) {
          result += styledLine.substring(i, escEnd + 1);
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
        result += `\x1b[30;103m${styledLine[i]}\x1b[0m`;
      } else if (inMatch) {
        // Other matches: yellow bg
        result += `\x1b[43m${styledLine[i]}\x1b[49m`;
      } else {
        result += styledLine[i];
      }

      plainIdx++;
      i++;
    }

    return result;
  }

  /**
   * Calculate visual selection range for a given line
   * @param {number} lineIdx - Buffer line index
   * @param {object} agent - Agent with getLineText method
   * @returns {object|null} - {hlStart, hlEnd, cursorLine, cursorCol} or null if line not in selection
   */
  getSelectionRangeOnLine(lineIdx, agent) {
    const { visualAnchor, visualCursor, mode } = this.visualState;

    // Determine selection bounds (swap if anchor > cursor)
    let startLine = visualAnchor.line;
    let startCol = visualAnchor.col;
    let endLine = visualCursor.line;
    let endCol = visualCursor.col;

    if (startLine > endLine || (startLine === endLine && startCol > endCol)) {
      [startLine, endLine] = [endLine, startLine];
      [startCol, endCol] = [endCol, startCol];
    }

    // Check if this line is within the selection
    if (lineIdx < startLine || lineIdx > endLine) {
      return null;
    }

    const lineText = agent.getLineText(lineIdx) || '';
    const lineLength = lineText.length;

    let hlStart, hlEnd;

    if (mode === 'vline') {
      // Visual line mode: highlight entire line
      hlStart = 0;
      hlEnd = lineLength;
    } else {
      // Visual char mode: calculate column range
      if (startLine === endLine) {
        // Single line selection
        hlStart = startCol;
        hlEnd = endCol + 1; // Include the end character
      } else if (lineIdx === startLine) {
        // First line of multi-line selection
        hlStart = startCol;
        hlEnd = lineLength;
      } else if (lineIdx === endLine) {
        // Last line of multi-line selection
        hlStart = 0;
        hlEnd = endCol + 1;
      } else {
        // Middle line: highlight entire line
        hlStart = 0;
        hlEnd = lineLength;
      }
    }

    // Clamp to line bounds
    hlStart = Math.max(0, hlStart);
    hlEnd = Math.min(lineLength, hlEnd);

    return {
      hlStart,
      hlEnd,
      cursorLine: visualCursor.line,
      cursorCol: visualCursor.col
    };
  }

  /**
   * Highlight visual selection in a line
   * @param {string} styledLine - Line with ANSI codes
   * @param {string} plainLine - Plain text line
   * @param {object} selRange - {hlStart, hlEnd, cursorLine, cursorCol}
   * @param {number} lineIdx - Line index
   * @returns {string} Line with visual selection highlights applied
   */
  highlightVisualSelection(styledLine, plainLine, selRange, lineIdx) {
    const { hlStart, hlEnd, cursorLine, cursorCol } = selRange;

    let result = '';
    let plainIdx = 0;
    let i = 0;

    while (i < styledLine.length) {
      // Skip ANSI escape sequences
      if (styledLine[i] === '\x1b' && styledLine[i + 1] === '[') {
        const escEnd = styledLine.indexOf('m', i);
        if (escEnd !== -1) {
          result += styledLine.substring(i, escEnd + 1);
          i = escEnd + 1;
          continue;
        }
      }

      // Check if this position is in the selection
      const inSelection = plainIdx >= hlStart && plainIdx < hlEnd;
      const isCursor = lineIdx === cursorLine && plainIdx === cursorCol;

      if (isCursor) {
        // Cursor position: underline + inverse
        result += `\x1b[4;7m${styledLine[i]}\x1b[0m`;
      } else if (inSelection) {
        // Selected: inverse video
        result += `\x1b[7m${styledLine[i]}\x1b[0m`;
      } else {
        result += styledLine[i];
      }

      plainIdx++;
      i++;
    }

    // If selection extends beyond the line content (e.g., visual-line mode on empty line)
    // show cursor at end of line if it's the cursor line
    if (lineIdx === cursorLine && cursorCol >= plainLine.length) {
      result += `\x1b[4;7m \x1b[0m`;
    }

    return result;
  }

  /**
   * Highlight normal mode cursor position
   * @param {string} styledLine - Line with ANSI codes
   * @param {string} plainLine - Plain text line
   * @param {number} col - Cursor column
   * @returns {string} Line with cursor highlight
   */
  highlightNormalCursor(styledLine, plainLine, col) {
    let result = '';
    let plainIdx = 0;
    let i = 0;
    let lastEsc = '';  // Track last escape sequence to restore after cursor

    while (i < styledLine.length) {
      // Skip ANSI escape sequences, but remember them
      if (styledLine[i] === '\x1b') {
        const escEnd = styledLine.indexOf('m', i);
        if (escEnd !== -1) {
          lastEsc = styledLine.substring(i, escEnd + 1);
          result += lastEsc;
          i = escEnd + 1;
          continue;
        }
      }

      if (plainIdx === col) {
        // Cursor: underline + inverse, then restore previous style
        result += `\x1b[4;7m${styledLine[i]}\x1b[0m${lastEsc}`;
      } else {
        result += styledLine[i];
      }

      plainIdx++;
      i++;
    }

    // If cursor is beyond end of line, show block cursor
    if (col >= plainLine.length) {
      result += `\x1b[4;7m \x1b[0m`;
    }

    return result;
  }

  /**
   * Render borders between panes
   */
  renderBorders(frame) {
    this.drawBordersForNode(frame, this.layoutManager.layout);
  }

  drawBordersForNode(frame, node) {
    if (!node || node.type !== 'container') return;

    const { x, y, width, height } = node.bounds;
    const isHorizontal = node.orientation === 'horizontal';

    let offset = 0;
    for (let i = 0; i < node.children.length - 1; i++) {
      const ratio = node.ratios[i] || (1 / node.children.length);
      const size = Math.floor((isHorizontal ? width : height) * ratio);
      offset += size;

      if (isHorizontal) {
        // Vertical border
        const borderX = x + offset - 1;
        for (let row = y; row < y + height && row < this.rows - 1; row++) {
          if (borderX >= 0 && borderX < this.cols) {
            frame[row][borderX].char = '│';
            frame[row][borderX].fg = 8; // Dim
          }
        }
      } else {
        // Horizontal border
        const borderY = y + offset - 1;
        if (borderY >= 0 && borderY < this.rows - 1) {
          for (let col = x; col < x + width && col < this.cols; col++) {
            frame[borderY][col].char = '─';
            frame[borderY][col].fg = 8;
          }
        }
      }
    }

    // Recurse into children
    for (const child of node.children) {
      this.drawBordersForNode(frame, child);
    }
  }

  /**
   * Render status bar (last row)
   */
  renderStatusBar(frame) {
    const y = this.rows - 1;
    const focusedAgent = this.layoutManager.getFocusedAgent();
    const panes = this.layoutManager.getAllPanes();
    const focusedPane = this.layoutManager.getFocusedPane();

    // Build left status string
    let left = '';

    // Zoom indicator
    if (this.layoutManager?.isZoomed?.()) {
      left += '[ZOOM] ';
    }

    // Mode indicator from InputRouter
    const mode = this.inputRouter?.mode;
    if (mode === 'insert') {
      left += '[INSERT] ';
    } else if (mode === 'normal') {
      left += '[NORMAL] ';
    } else if (mode === 'visual') {
      left += '[VISUAL] ';
    } else if (mode === 'visual-line') {
      left += '[V-LINE] ';
    } else if (mode === 'search') {
      left += '[SEARCH] ';
    } else if (mode === 'command') {
      left += '[COMMAND] ';
    }

    // Pane index
    if (panes.length > 1) {
      const focusedIdx = panes.findIndex(p => p.id === this.layoutManager.focusedPaneId);
      left += `[${focusedIdx + 1}/${panes.length}] `;
    }

    // Register indicator
    if (this.visualState?.awaitingRegister) {
      left += '"_ ';
    } else if (this.visualState?.selectedRegister) {
      left += `"${this.visualState.selectedRegister} `;
    }

    // Command prompt (ex mode)
    if (this.commandState?.active) {
      left += `:${this.commandState.buffer}_ `;
    }
    // Search prompt or status
    else if (this.searchState?.active) {
      left += `/${this.searchState.pattern}_ `;
    } else if (this.searchState?.matches?.length > 0) {
      left += `[${this.searchState.index + 1}/${this.searchState.matches.length}] `;
    }

    // Build right status string
    let right = '';

    // Scroll position [startLine-endLine/totalLines] or position indicator
    if (focusedPane && focusedAgent) {
      const scrollY = this.scrollOffsets.get(focusedPane.id) || 0;
      const contentHeight = focusedAgent.getContentHeight();
      const viewHeight = focusedPane.bounds.height;
      const startLine = scrollY + 1;
      const endLine = Math.min(scrollY + viewHeight, contentHeight);

      if (contentHeight > viewHeight) {
        // Show scroll position when content exceeds view
        const atTop = scrollY === 0;
        const atBottom = scrollY >= contentHeight - viewHeight;
        let posIndicator;
        if (atTop) posIndicator = 'Top';
        else if (atBottom) posIndicator = 'Bot';
        else posIndicator = `${Math.round((scrollY / (contentHeight - viewHeight)) * 100)}%`;

        right += `[${startLine}-${endLine}/${contentHeight}] ${posIndicator} `;
      } else {
        right += 'All ';
      }
    }

    // Agent info
    if (focusedAgent) {
      let statusIcon;
      if (focusedAgent.status === 'running') {
        statusIcon = '●';
      } else if (focusedAgent.status === 'error') {
        statusIcon = '✖';
      } else {
        statusIcon = '○';
      }
      right += `${focusedAgent.name} ${statusIcon}`;
    }

    // Context-sensitive hint in the middle
    let hint = '';
    if (this.searchState?.active) {
      hint = 'Enter:search Esc:cancel';
    } else if (this.commandState?.active) {
      hint = 'Enter:execute Esc:cancel';
    } else if (mode === 'insert') {
      hint = 'Esc:normal';
    } else if (mode === 'normal') {
      hint = 'i:insert /:search ::cmd';
    } else if (mode === 'visual' || mode === 'visual-line') {
      hint = 'y:yank Esc:cancel';
    }

    // Calculate padding
    const totalLen = left.length + hint.length + right.length + 2; // +2 for edge spaces
    const padding = Math.max(0, this.cols - totalLen);
    const leftPad = Math.floor(padding / 2);
    const rightPad = padding - leftPad;

    // Write status bar with inverse colors
    let fullStatus = '\x1b[7m ' + left;
    fullStatus += ' '.repeat(leftPad);
    fullStatus += hint;
    fullStatus += ' '.repeat(rightPad);
    fullStatus += right + ' \x1b[0m';

    this.writeRawToFrame(frame, 0, y, fullStatus);
  }

  /**
   * Convert frame to ANSI output string
   */
  output() {
    if (!this.frame) return '';

    let result = '';

    // Move to top-left
    result += '\x1b[H';

    // DEC 2026 synchronized update begin
    result += '\x1b[?2026h';

    let lastFg = null;
    let lastBg = null;
    let lastAttrs = 0;

    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const cell = this.frame[y][x];

        // Check if style changed
        if (cell.fg !== lastFg || cell.bg !== lastBg || cell.attrs !== lastAttrs) {
          result += this.buildSGR(cell.fg, cell.bg, cell.attrs);
          lastFg = cell.fg;
          lastBg = cell.bg;
          lastAttrs = cell.attrs;
        }

        result += cell.char;
      }

      if (y < this.rows - 1) {
        result += '\r\n';
      }
    }

    // Reset, end synchronized update, hide cursor
    // Always hide the real terminal cursor - agent apps render their own cursor
    // in the terminal buffer which we display. Trying to show/position the real
    // cursor causes flickering conflicts with agents' cursor control sequences.
    result += '\x1b[0m\x1b[?2026l\x1b[?25l';

    return result;
  }

  /**
   * Build SGR escape sequence from style
   */
  buildSGR(fg, bg, attrs) {
    const codes = [0]; // Reset first

    if (attrs & 1) codes.push(1);  // Bold
    if (attrs & 2) codes.push(2);  // Dim
    if (attrs & 4) codes.push(3);  // Italic
    if (attrs & 8) codes.push(4);  // Underline
    if (attrs & 16) codes.push(7); // Inverse
    if (attrs & 32) codes.push(9); // Strikethrough

    if (fg !== null) {
      if (typeof fg === 'number') {
        if (fg < 8) codes.push(30 + fg);
        else codes.push(90 + fg - 8);
      } else if (fg.type === '256') {
        codes.push(38, 5, fg.value);
      } else if (fg.type === 'rgb') {
        codes.push(38, 2, fg.r, fg.g, fg.b);
      }
    }

    if (bg !== null) {
      if (typeof bg === 'number') {
        if (bg < 8) codes.push(40 + bg);
        else codes.push(100 + bg - 8);
      } else if (bg.type === '256') {
        codes.push(48, 5, bg.value);
      } else if (bg.type === 'rgb') {
        codes.push(48, 2, bg.r, bg.g, bg.b);
      }
    }

    return `\x1b[${codes.join(';')}m`;
  }

  /**
   * Scroll pane by delta
   */
  scrollPane(paneId, delta) {
    const pane = this.layoutManager.findPane(paneId);
    if (!pane) return;

    const agent = this.session.getAgent(pane.agentId);
    if (!agent) return;

    let scrollY = this.scrollOffsets.get(paneId) || 0;
    const contentHeight = agent.getContentHeight();
    const maxScroll = Math.max(0, contentHeight - pane.bounds.height);

    scrollY = Math.max(0, Math.min(maxScroll, scrollY + delta));
    this.scrollOffsets.set(paneId, scrollY);

    // Set followTail based on whether we're at the bottom (like index.js)
    this.followTail.set(paneId, scrollY >= maxScroll);
  }

  /**
   * Scroll focused pane
   */
  scrollFocused(delta) {
    this.scrollPane(this.layoutManager.focusedPaneId, delta);
  }

  /**
   * Jump to top/bottom of focused pane
   */
  scrollFocusedTo(position) {
    const paneId = this.layoutManager.focusedPaneId;
    const pane = this.layoutManager.findPane(paneId);
    if (!pane) return;

    const agent = this.session.getAgent(pane.agentId);
    if (!agent) return;

    if (position === 'top') {
      this.scrollOffsets.set(paneId, 0);
      this.followTail.set(paneId, false);  // Stop following tail when jumping to top
    } else if (position === 'bottom') {
      const contentHeight = agent.getContentHeight();
      const maxScroll = Math.max(0, contentHeight - pane.bounds.height);
      this.scrollOffsets.set(paneId, maxScroll);
      this.followTail.set(paneId, true);   // Resume following tail at bottom
    }
  }
}

module.exports = { Compositor };
