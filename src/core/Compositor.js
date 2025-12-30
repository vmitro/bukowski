// src/core/Compositor.js - Multi-viewport rendering compositor
// Renders like index.js: direct line output with preserved ANSI codes

class Compositor {
  constructor(session, layoutManager, tabBar, chatPane, conversationList, overlayManager = null) {
    this.session = session;
    this.layoutManager = layoutManager;
    this.tabBar = tabBar;
    this.chatPane = chatPane;
    this.conversationList = conversationList;
    this.overlayManager = overlayManager;  // For modal overlays (ACL input, agent picker)
    this.cols = 80;
    this.rows = 24;
    this.scrollOffsets = new Map(); // paneId -> scrollY
    this.followTail = new Map();    // paneId -> boolean (whether to auto-scroll)
    this.drawScheduled = false;     // Throttle like index.js scheduleDraw()
    this.searchState = null; // Will be set from multi.js
    this.visualState = null; // Will be set from multi.js - {mode, visualAnchor, visualCursor}
    this.cursorBlinkVisible = true;
    this.cursorBlinkInterval = null;

    // Resize state machine - single source of truth for resize handling
    // Phases: 'idle' | 'cached' | 'reflowing'
    //   idle     - normal operation, live rendering from xterm.js
    //   cached   - using cached frames during resize debounce (prevents ugly-wrap)
    //   reflowing - waiting for agent output to stabilize after SIGWINCH
    this.resizePhase = 'idle';

    // Resize data (only valid when resizePhase !== 'idle')
    this.resizeCache = new Map();  // paneId -> { scrollY, atBottom }
    this.frameCache = new Map();   // paneId -> { lines: string[], width: number }
  }

  startCursorBlink() {
    if (this.cursorBlinkInterval) return;
    this.cursorBlinkInterval = setInterval(() => {
      this.cursorBlinkVisible = !this.cursorBlinkVisible;
      this.scheduleDraw();
    }, 530);
  }

  stopCursorBlink() {
    if (this.cursorBlinkInterval) {
      clearInterval(this.cursorBlinkInterval);
      this.cursorBlinkInterval = null;
    }
  }

  resetCursorBlink() {
    // Keep cursor visible and restart timer (for keystroke feedback)
    this.stopCursorBlink();
    this.cursorBlinkVisible = true;
    this.startCursorBlink();
  }

  /**
   * Schedule a throttled draw (exactly like index.js pattern)
   */
  scheduleDraw() {
    if (!this.drawScheduled) {
      this.drawScheduled = true;
      setTimeout(() => {
        this.drawScheduled = false;
        // Skip auto-scroll during resize phases
        // Positions will be restored after resize completes
        if (this.resizePhase === 'idle') {
          if (this.followTail.get(this.layoutManager.focusedPaneId) !== false) {
            this.scrollFocusedToBottom();
          }
          // Also update other panes that are following tail
          this.updateFollowTailScrolls();
        }
        this.draw();
      }, 16);
    }
  }

  /**
   * Scroll focused pane to bottom (like index.js scrollToBottom)
   */
  scrollFocusedToBottom() {
    const paneId = this.layoutManager.focusedPaneId;
    const pane = this.layoutManager.findPane(paneId);
    if (!pane) return;

    const agent = this.session.getAgent(pane.agentId);
    if (!agent) return;

    const contentHeight = agent.getContentHeight();
    const maxScroll = Math.max(0, contentHeight - pane.bounds.height);
    this.scrollOffsets.set(paneId, maxScroll);
  }

  /**
   * Update scroll positions for non-focused panes with followTail enabled
   */
  updateFollowTailScrolls() {
    for (const pane of this.layoutManager.getAllPanes()) {
      const paneId = pane.id;
      if (paneId === this.layoutManager.focusedPaneId) continue; // Already handled

      if (this.followTail.get(paneId) !== false) {
        const agent = this.session.getAgent(pane.agentId);
        if (!agent) continue;

        const contentHeight = agent.getContentHeight();
        const maxScroll = Math.max(0, contentHeight - pane.bounds.height);
        this.scrollOffsets.set(paneId, maxScroll);
      }
    }
  }

  /**
   * Update compositor and layout bounds only (no scroll caching)
   * Used for two-phase resize: update bounds → draw cropped → reflow → draw final
   */
  updateBounds(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    // Reserve: 1 row for tab bar, 1 row for status bar
    this.layoutManager.calculateBounds(0, 1, cols, rows - 2);
  }

  /**
   * Cache scroll positions before terminal reflow
   * Call this AFTER updateBounds but BEFORE agent.resize()
   */
  cacheScrollPositions() {
    for (const pane of this.layoutManager.getAllPanes()) {
      const scrollY = this.scrollOffsets.get(pane.id) || 0;
      const agent = this.session.getAgent(pane.agentId);
      if (agent) {
        const contentHeight = agent.getContentHeight();
        const maxScroll = Math.max(0, contentHeight - pane.bounds.height);
        // Only detect atBottom when there's scrollable content
        // Otherwise preserve current followTail state
        const currentFollowTail = this.followTail.get(pane.id);
        const atBottom = maxScroll > 0
          ? (scrollY >= maxScroll - 1)
          : (currentFollowTail !== false);

        this.resizeCache.set(pane.id, { scrollY, atBottom });
      }
    }
  }

  /**
   * Combined resize (for backward compatibility)
   */
  resize(cols, rows) {
    this.cacheScrollPositions();
    this.updateBounds(cols, rows);
  }

  /**
   * Restore scroll positions after resize/reflow
   * Uses cached state to preserve user's scroll position
   */
  restoreScrollPositions() {
    for (const [paneId, cached] of this.resizeCache) {
      const pane = this.layoutManager.findPane(paneId);
      if (!pane) continue;

      const agent = this.session.getAgent(pane.agentId);
      if (!agent) continue;

      const contentHeight = agent.getContentHeight();
      const newMaxScroll = Math.max(0, contentHeight - pane.bounds.height);

      if (cached.atBottom) {
        // Was following tail → stay at bottom
        this.scrollOffsets.set(paneId, newMaxScroll);
        this.followTail.set(paneId, true);
      } else {
        // Was scrolled up → preserve position (clamped to valid range)
        const newScrollY = Math.min(cached.scrollY, newMaxScroll);
        this.scrollOffsets.set(paneId, Math.max(0, newScrollY));
        this.followTail.set(paneId, false);
      }
    }

    this.resizeCache.clear();
  }

  /**
   * Capture current visible frames for all panes (true double-buffering)
   * Call this BEFORE any resize to snapshot current display
   */
  captureFrames() {
    for (const pane of this.layoutManager.getAllPanes()) {
      const agent = this.session.getAgent(pane.agentId);
      if (!agent) continue;

      const { width, height } = pane.bounds;
      const scrollY = this.scrollOffsets.get(pane.id) || 0;
      const contentHeight = agent.getContentHeight();

      // Capture visible lines
      const lines = [];
      for (let row = 0; row < height; row++) {
        const bufferLine = scrollY + row;
        if (bufferLine < contentHeight) {
          lines.push(agent.getLine(bufferLine));
        } else {
          lines.push('');  // Empty line beyond content
        }
      }

      this.frameCache.set(pane.id, { lines, width });
    }
    this.resizePhase = 'cached';
  }

  /**
   * Transition to 'reflowing' phase (after SIGWINCH sent, waiting for output to stabilize)
   */
  startReflowing() {
    this.resizePhase = 'reflowing';
  }

  /**
   * Clear frame cache and return to live rendering (idle phase)
   */
  clearFrameCache() {
    this.frameCache.clear();
    this.resizePhase = 'idle';
  }

  /**
   * Main draw function - renders directly like index.js
   */
  draw() {
    // During 'reflowing' phase, skip draws to avoid showing intermediate states
    // (agents are processing SIGWINCH and producing transitional output)
    if (this.resizePhase === 'reflowing') return;

    const mode = this.inputRouter?.getMode();

    if (mode === 'chat') {
      this.drawChat();
      return;
    }

    const panes = this.layoutManager.getAllPanes();
    const focusedPaneId = this.layoutManager.focusedPaneId;

    // Build output with DEC 2026 sync update (like index.js)
    let frame = '\x1b[?2026h';      // Begin sync update
    frame += '\x1b[?25l\x1b[H';     // Hide cursor, home

    // Row 0: Tab bar
    frame += '\x1b[1;1H\x1b[2K';
    frame += this.renderTabBar();

    // Render each pane's content
    for (const pane of panes) {
      frame += this.renderPaneContent(pane, pane.id === focusedPaneId);
    }

    // Render borders between panes
    frame += this.renderBorders();

    // Render overlays ON TOP of pane content (modal dialogs, ACL input, etc.)
    frame += this.renderOverlays();

    // Last row: Status bar
    frame += `\x1b[${this.rows};1H\x1b[2K`;
    frame += this.renderStatusBar();

    frame += '\x1b[?25h';           // Show cursor
    frame += '\x1b[?2026l';         // End sync update

    process.stdout.write(frame);
  }

  /**
   * Main draw function for chat mode
   */
  drawChat() {
    let frame = '\x1b[?2026h';      // Begin sync update
    frame += '\x1b[?25l\x1b[H';     // Hide cursor, home

    const listWidth = 30;
    const chatWidth = this.cols - listWidth;

    // Render ConversationList (left) and ChatPane (right)
    // Reserve 2 rows: 1 for input line, 1 for status bar
    const listLines = this.conversationList.render(listWidth, this.rows - 2);
    const chatLines = this.chatPane.render(chatWidth, this.rows - 2);

    for (let i = 0; i < this.rows - 2; i++) {
      const screenY = i + 1;
      frame += `\x1b[${screenY};1H${listLines[i] || ''}`;
      frame += `\x1b[${screenY};${listWidth + 1}H${chatLines[i] || ''}`;
    }

    // Input line (second to last row)
    frame += `\x1b[${this.rows - 1};1H\x1b[2K`;
    frame += this.renderChatInput();

    // Last row: Status bar
    frame += `\x1b[${this.rows};1H\x1b[2K`;
    frame += this.renderStatusBar();

    frame += '\x1b[?25h';           // Show cursor
    frame += '\x1b[?2026l';         // End sync update

    process.stdout.write(frame);
  }

  /**
   * Render chat input line
   */
  renderChatInput() {
    const chatState = this.chatState || {};
    const input = chatState.inputBuffer || '';
    const performative = chatState.pendingPerformative || 'inform';
    const selectedAgent = chatState.selectedAgent;

    // Build prompt: [PERF] @target: message_
    let prompt = '';

    // Performative indicator
    const perfColors = {
      'request': '\x1b[36m',    // cyan
      'inform': '\x1b[37m',     // white
      'query-if': '\x1b[33m',   // yellow
      'query-ref': '\x1b[33m',  // yellow
      'cfp': '\x1b[35m',        // magenta
      'propose': '\x1b[34m',    // blue
      'agree': '\x1b[32m',      // green
      'refuse': '\x1b[31m',     // red
      'subscribe': '\x1b[36m',  // cyan
    };
    const perfColor = perfColors[performative] || '\x1b[37m';
    prompt += `${perfColor}[${performative.toUpperCase()}]\x1b[0m `;

    // Target agent
    if (selectedAgent) {
      prompt += `\x1b[36m@${selectedAgent}\x1b[0m: `;
    } else {
      prompt += '\x1b[2m<Tab to select agent>\x1b[0m ';
    }

    // Input buffer with cursor
    const cursorPos = input.length;
    const visibleInput = input + '\x1b[7m \x1b[27m'; // Block cursor

    prompt += visibleInput;

    // Pad to width
    const visibleLen = this._stripAnsi(prompt).length;
    const padding = Math.max(0, this.cols - visibleLen);

    return '\x1b[48;5;236m ' + prompt + ' '.repeat(padding) + '\x1b[0m';
  }

  /**
   * Strip ANSI codes (helper for chat input)
   */
  _stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
  }

  /**
   * Render tab bar (like index.js status bar approach)
   */
  renderTabBar() {
    const agents = this.session.getAllAgents();
    const focusedPane = this.layoutManager.getFocusedPane();

    const tabs = agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      active: focusedPane?.agentId === agent.id,
      status: agent.status
    }));

    this.tabBar.setTabs(tabs);
    return this.tabBar.render(this.cols);
  }

  /**
   * Render a single pane's content (like index.js draw())
   */
  renderPaneContent(pane, isFocused) {
    const { x, y, width, height } = pane.bounds;

    // TRUE DOUBLE-BUFFERING: During 'cached' phase, render from cached frame
    // This prevents "ugly-wrap" artifacts from reading xterm.js mid-reflow
    if (this.resizePhase === 'cached') {
      const cached = this.frameCache.get(pane.id);
      if (cached) {
        let result = '';
        for (let row = 0; row < height; row++) {
          const screenY = y + row + 1;
          result += `\x1b[${screenY};${x + 1}H`;

          // Get cached line (or empty if beyond cached content)
          const lineContent = row < cached.lines.length ? cached.lines[row] : '';

          // Crop or pad cached line to new width
          result += this.fitToWidth(lineContent, width);
        }
        return result;
      }
    }

    const agent = this.session.getAgent(pane.agentId);
    if (!agent) return '';

    let scrollY = this.scrollOffsets.get(pane.id) || 0;
    const contentHeight = agent.getContentHeight();
    const maxScroll = Math.max(0, contentHeight - height);

    // Clamp scroll locally for render only - don't modify state during render
    // (state modification during render causes race conditions / visual flicker)
    if (scrollY > maxScroll) {
      scrollY = maxScroll;
    }

    let result = '';

    // Render visible lines (like index.js visible[] building)
    for (let row = 0; row < height; row++) {
      const bufferLine = scrollY + row;
      const screenY = y + row + 1; // +1 for 1-indexed cursor positioning

      // Position cursor and clear line portion
      result += `\x1b[${screenY};${x + 1}H`;

      let lineContent = '';
      if (bufferLine < contentHeight) {
        lineContent = agent.getLine(bufferLine);

        // Apply highlighting like index.js does
        if (isFocused) {
          const plainLine = agent.getLineText(bufferLine);

          // Search highlights
          if (this.searchState?.matches?.length > 0) {
            const lineMatches = this.searchState.matches.filter(m => m.line === bufferLine);
            if (lineMatches.length > 0) {
              lineContent = this.highlightSearchMatches(lineContent, plainLine, lineMatches, bufferLine);
            }
          }

          // Visual selection highlights
          if (this.visualState && (this.visualState.mode === 'visual' || this.visualState.mode === 'vline')) {
            lineContent = this.applyVisualHighlight(lineContent, plainLine, bufferLine);
          }

          // Normal mode cursor
          if (this.visualState?.mode === 'normal' && this.visualState.normalCursor) {
            if (bufferLine === this.visualState.normalCursor.line) {
              lineContent = this.insertCursorMarker(lineContent, plainLine, this.visualState.normalCursor.col);
            }
          }

          // Insert mode: show agent's actual cursor (blinking) - only for agents that need it
          if (agent.needsFakeCursor && (!this.visualState || this.visualState.mode === 'insert') && this.cursorBlinkVisible) {
            const cursorPos = agent.getCursorPosition();
            if (cursorPos && bufferLine === cursorPos.line) {
              lineContent = this.insertCursorMarker(lineContent, plainLine, cursorPos.col);
            }
          }
        }
      }

      // Truncate/pad to pane width and output
      result += this.fitToWidth(lineContent, width);
    }

    return result;
  }

  /**
   * Fit line content to width, handling ANSI codes
   */
  fitToWidth(line, width) {
    let visibleLen = 0;
    let result = '';
    let i = 0;

    while (i < line.length && visibleLen < width) {
      if (line[i] === '\x1b') {
        // ANSI escape - copy until 'm'
        const escEnd = line.indexOf('m', i);
        if (escEnd !== -1) {
          result += line.substring(i, escEnd + 1);
          i = escEnd + 1;
          continue;
        }
      }
      result += line[i];
      visibleLen++;
      i++;
    }

    // Pad with spaces if needed
    if (visibleLen < width) {
      result += ' '.repeat(width - visibleLen);
    }

    // Reset at end
    result += '\x1b[0m';
    return result;
  }

  /**
   * Render borders between panes
   */
  renderBorders() {
    let result = '';
    result += this.renderBordersForNode(this.layoutManager.layout);
    return result;
  }

  renderBordersForNode(node) {
    if (!node || node.type !== 'container') return '';

    let result = '';
    const { x, y, width, height } = node.bounds;
    const isHorizontal = node.orientation === 'horizontal';

    // Use child bounds directly instead of recalculating from ratios
    // This avoids rounding errors that can clip pane content
    for (let i = 0; i < node.children.length - 1; i++) {
      const child = node.children[i];
      const cb = child.bounds;

      if (isHorizontal) {
        // Vertical border at right edge of child
        const borderX = cb.x + cb.width;
        for (let row = y; row < y + height; row++) {
          const screenY = row + 1; // 1-indexed
          const screenX = borderX + 1;
          if (screenX > 0 && screenX <= this.cols && screenY > 0 && screenY < this.rows) {
            result += `\x1b[${screenY};${screenX}H\x1b[2m│\x1b[0m`;
          }
        }
      } else {
        // Horizontal border at bottom edge of child
        const borderY = cb.y + cb.height;
        const screenY = borderY + 1;
        if (screenY > 0 && screenY < this.rows) {
          for (let col = x; col < x + width; col++) {
            const screenX = col + 1;
            if (screenX > 0 && screenX <= this.cols) {
              result += `\x1b[${screenY};${screenX}H\x1b[2m─\x1b[0m`;
            }
          }
        }
      }
    }

    // Recurse
    for (const child of node.children) {
      result += this.renderBordersForNode(child);
    }

    return result;
  }

  /**
   * Render overlays on top of pane content
   * Overlays are drawn last so they appear above everything
   */
  renderOverlays() {
    if (!this.overlayManager || !this.overlayManager.hasActiveOverlay()) {
      return '';
    }

    let result = '';

    // Render all overlays in z-order (back to front)
    for (const overlay of this.overlayManager.getAllInOrder()) {
      const { x, y, width, height } = overlay.bounds;

      // First pass: clear the overlay area completely with spaces
      // This prevents any pane content from bleeding through
      for (let row = 0; row < height; row++) {
        const screenY = y + row + 1;
        const screenX = x + 1;
        if (screenY > 0 && screenY <= this.rows && screenX > 0) {
          // Reset attributes, position, write spaces for full width
          result += `\x1b[${screenY};${screenX}H\x1b[0m${' '.repeat(width)}`;
        }
      }

      // Second pass: render the overlay content on top
      const rendered = overlay.render();

      for (const { row, col, content } of rendered) {
        // Convert to 1-indexed screen coordinates
        const screenY = row + 1;
        const screenX = col + 1;

        // Bounds check
        if (screenY > 0 && screenY <= this.rows && screenX > 0 && screenX <= this.cols) {
          // Position cursor, reset any prior state, then render content
          result += `\x1b[${screenY};${screenX}H\x1b[0m${content}`;
        }
      }
    }

    return result;
  }

  /**
   * Render status bar (like index.js)
   */
  renderStatusBar() {
    const focusedAgent = this.layoutManager.getFocusedAgent();
    const panes = this.layoutManager.getAllPanes();
    const focusedPane = this.layoutManager.getFocusedPane();

    // Build left part
    let left = '';

    // Zoom indicator
    if (this.layoutManager?.isZoomed?.()) {
      left += '[ZOOM] ';
    }

    // Mode indicator
    const mode = this.inputRouter?.mode;
    const modeNames = { insert: 'INSERT', normal: 'NORMAL', visual: 'VISUAL', 'visual-line': 'V-LINE', search: 'SEARCH', command: 'COMMAND', chat: 'CHAT', 'acl-send': 'ACL' };
    if (mode && modeNames[mode]) {
      left += `[${modeNames[mode]}] `;
    }

    // Pane index
    if (panes.length > 1) {
      const focusedIdx = panes.findIndex(p => p.id === this.layoutManager.focusedPaneId);
      left += `[${focusedIdx + 1}/${panes.length}] `;
    }

    // Search/command status
    if (this.commandState?.active) {
      left += `:${this.commandState.buffer}_ `;
    } else if (this.searchState?.active) {
      left += `/${this.searchState.pattern}_ `;
    } else if (this.searchState?.matches?.length > 0) {
      left += `[${this.searchState.index + 1}/${this.searchState.matches.length}] `;
    }

    // Build right part
    let right = '';

    if (focusedPane && focusedAgent) {
      const scrollY = this.scrollOffsets.get(focusedPane.id) || 0;
      const contentHeight = focusedAgent.getContentHeight();
      const viewHeight = focusedPane.bounds.height;
      const maxScroll = Math.max(0, contentHeight - viewHeight);

      const from = contentHeight ? scrollY + 1 : 0;
      const to = Math.min(scrollY + viewHeight, contentHeight);

      let pctStr;
      if (scrollY <= 0) pctStr = 'Top';
      else if (scrollY >= maxScroll) pctStr = 'Bot';
      else pctStr = `${Math.round(100 * scrollY / maxScroll)}%`;

      right += `[${from}-${to}/${contentHeight}] ${pctStr} `;
    }

    if (focusedAgent) {
      const statusIcon = focusedAgent.status === 'running' ? '●' : (focusedAgent.status === 'error' ? '✖' : '○');
      right += `${focusedAgent.name} ${statusIcon}`;
    }

    // Center hint
    let hint = '';
    const prefixState = this.inputRouter?.getPrefixState?.();
    if (prefixState) {
      if (prefixState === 'fipa') {
        hint = '(f)ipa: (r)eq (i)nfo (q)uery (c)fp (s)ub';
      } else if (prefixState === 'layout') {
        hint = '(w)layout: (s)plit (v)split (c)lose (z)oom';
      } else if (prefixState === 'ipc') {
        hint = '(a)gent: (s)end (b)cast (l)og';
      } else {
        hint = 'bukowski';
      }
    } else if (this.searchState?.active) {
      hint = 'Enter:search Esc:cancel';
    } else if (this.commandState?.active) {
      hint = 'Enter:execute Esc:cancel';
    } else if (mode === 'insert') {
      hint = 'CTRL+Space:cmd Esc:normal';
    } else if (mode === 'normal') {
      hint = 'i:insert /:search ::cmd';
    } else if (mode === 'visual' || mode === 'visual-line') {
      hint = 'y:yank Esc:cancel';
    } else if (mode === 'chat') {
      hint = 'Tab:agent Ctrl+P:perf Enter:send Esc:exit';
    }

    // Build padded status line (like index.js)
    const totalLen = left.length + hint.length + right.length + 2;
    const padding = Math.max(0, this.cols - totalLen);
    const leftPad = Math.floor(padding / 2);
    const rightPad = padding - leftPad;

    let status = '\x1b[7m ' + left;
    status += ' '.repeat(leftPad);
    status += hint;
    status += ' '.repeat(rightPad);
    status += right + ' \x1b[0m';

    return status;
  }

  /**
   * Highlight search matches (like index.js highlightSearchMatches)
   */
  highlightSearchMatches(line, plainLine, matches, lineIdx) {
    const currentMatch = this.searchState.matches[this.searchState.index];
    const isCurrentLine = currentMatch && currentMatch.line === lineIdx;

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
        result += `\x1b[30;103m${line[i]}\x1b[0m`;
      } else if (inMatch) {
        result += `\x1b[43m${line[i]}\x1b[49m`;
      } else {
        result += line[i];
      }

      plainIdx++;
      i++;
    }

    return result;
  }

  /**
   * Apply visual selection highlight (like index.js highlightVisualSelection)
   */
  applyVisualHighlight(line, plainLine, lineIdx) {
    const { visualAnchor, visualCursor, mode } = this.visualState;

    // Determine selection bounds
    let startLine = visualAnchor.line;
    let startCol = visualAnchor.col;
    let endLine = visualCursor.line;
    let endCol = visualCursor.col;

    if (startLine > endLine || (startLine === endLine && startCol > endCol)) {
      [startLine, endLine] = [endLine, startLine];
      [startCol, endCol] = [endCol, startCol];
    }

    if (lineIdx < startLine || lineIdx > endLine) {
      if (lineIdx === visualCursor.line) {
        return this.insertCursorMarker(line, plainLine, visualCursor.col);
      }
      return line;
    }

    let hlStart = 0;
    let hlEnd = plainLine.length;

    if (mode === 'vline') {
      // Full line
    } else {
      if (lineIdx === startLine) hlStart = startCol;
      if (lineIdx === endLine) hlEnd = endCol + 1;
    }

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

      const inHighlight = plainIdx >= hlStart && plainIdx < hlEnd;
      const isCursor = lineIdx === visualCursor.line && plainIdx === visualCursor.col;

      if (isCursor) {
        result += `\x1b[4;7m${line[i]}\x1b[24;27m`;
      } else if (inHighlight) {
        result += `\x1b[7m${line[i]}\x1b[27m`;
      } else {
        result += line[i];
      }

      plainIdx++;
      i++;
    }

    if (lineIdx === visualCursor.line && visualCursor.col >= plainLine.length) {
      result += `\x1b[4;7m \x1b[24;27m`;
    }

    return result;
  }

  /**
   * Insert cursor marker (like index.js insertCursorMarker)
   */
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

    if (col >= plainIdx) {
      // Pad with spaces to reach cursor position (use plainIdx, not plainLine.length)
      const padding = col - plainIdx;
      result += ' '.repeat(padding);
      result += `\x1b[4;7m \x1b[24;27m`;
    }

    return result;
  }

  /**
   * Scroll pane by delta (like index.js scroll)
   */
  scrollPane(paneId, delta) {
    const pane = this.layoutManager.findPane(paneId);
    if (!pane) return;

    const agent = this.session.getAgent(pane.agentId);
    if (!agent) return;

    const contentHeight = agent.getContentHeight();
    const maxScroll = Math.max(0, contentHeight - pane.bounds.height);
    const oldScroll = this.scrollOffsets.get(paneId) || 0;

    let scrollY = Math.max(0, Math.min(maxScroll, oldScroll + delta));
    this.scrollOffsets.set(paneId, scrollY);

    // Update followTail like index.js
    this.followTail.set(paneId, scrollY >= maxScroll);

    if (scrollY !== oldScroll) {
      this.draw();
    }
  }

  /**
   * Scroll focused pane
   */
  scrollFocused(delta) {
    this.scrollPane(this.layoutManager.focusedPaneId, delta);
  }

  /**
   * Jump to top/bottom
   */
  scrollFocusedTo(position) {
    const paneId = this.layoutManager.focusedPaneId;
    const pane = this.layoutManager.findPane(paneId);
    if (!pane) return;

    const agent = this.session.getAgent(pane.agentId);
    if (!agent) return;

    if (position === 'top') {
      this.scrollOffsets.set(paneId, 0);
      this.followTail.set(paneId, false);
    } else if (position === 'bottom') {
      const contentHeight = agent.getContentHeight();
      const maxScroll = Math.max(0, contentHeight - pane.bounds.height);
      this.scrollOffsets.set(paneId, maxScroll);
      this.followTail.set(paneId, true);
    }
    this.draw();
  }
}

module.exports = { Compositor };
