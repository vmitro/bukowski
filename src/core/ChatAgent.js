// src/core/ChatAgent.js - Chat conversation as pseudo-agent
// Renders single FIPA conversation in agent-compatible interface

const EventEmitter = require('events');

class ChatAgent extends EventEmitter {
  constructor(conversationId, conversationManager, fipaHub) {
    super();

    this.conversationId = conversationId;
    this.conversations = conversationManager;
    this.fipaHub = fipaHub;

    // Agent interface
    this.id = `chat-${conversationId}`;
    this.name = this._getShortName(conversationId);
    this.type = 'chat';
    this.status = 'running';
    this.pty = null;  // No PTY
    this.needsFakeCursor = true;  // We render our own cursor

    // Chat state
    this.inputBuffer = '';
    this.inputCursor = 0;
    this._pasteBuffer = '';
    this.targetAgent = null;      // Target agent for messages
    this.performative = 'inform'; // Current performative
    this.scrollOffset = 0;
    this.autoScroll = true;

    // Rendering
    this.lines = [];           // Pre-rendered lines with ANSI
    this.plainLines = [];      // Plain text lines (for search)
    this.width = 80;
    this.showTimestamps = true;
    this.maxNickWidth = 8;     // Dynamic: recalculated from participants

    // Message history for this conversation
    this.messages = [];

    // Subscribe to conversation events
    this._setupListeners();

    // Load existing messages from restored conversations
    this._loadExistingMessages();

    this._render();
  }

  /**
   * Load messages from already-restored conversations
   * (for session restore - conversations exist before ChatAgent is created)
   */
  _loadExistingMessages() {
    // Get all conversations from manager
    const conversationsMap = this.conversations.conversations;
    if (!conversationsMap || conversationsMap.size === 0) {
      return; // No conversations to load
    }

    const allConversations = Array.from(conversationsMap.values());

    for (const conversation of allConversations) {
      for (const message of conversation.messages || []) {
        const sender = message.sender?.name;
        const receivers = Array.isArray(message.receiver)
          ? message.receiver.map(r => r.name)
          : [message.receiver?.name];

        // Add if user is sender or receiver
        if (sender === 'user' || receivers.includes('user')) {
          const chatMsg = this._formatMessage(message);
          this.messages.push(chatMsg);
        }
      }
    }

    // Sort by timestamp
    this.messages.sort((a, b) => a.timestamp - b.timestamp);
  }

  _getShortName(conversationId) {
    // Shorten UUID to first 5 chars
    const short = conversationId.slice(0, 5);
    return `Chat:${short}`;
  }

  _setupListeners() {
    // Listen for ALL messages involving "user" (not just one conversation)
    // This makes the chat pane a unified view of user<->agent communication
    this.conversations.on('message:received', ({ message, conversation }) => {
      const sender = message.sender?.name;
      const receivers = Array.isArray(message.receiver)
        ? message.receiver.map(r => r.name)
        : [message.receiver?.name];

      // Show if user is sender or receiver
      if (sender === 'user' || receivers.includes('user')) {
        this._addMessage(message);
      }
    });

    this.conversations.on('conversation:completed', (conversation) => {
      if (conversation.id === this.conversationId) {
        this.status = 'stopped';
        this._render();
      }
    });
  }

  _addMessage(fipaMessage) {
    const chatMsg = this._formatMessage(fipaMessage);
    this.messages.push(chatMsg);

    if (this.autoScroll) {
      this.scrollOffset = 0;
    }

    this._render();
    this.emit('data');  // Trigger compositor redraw
  }

  _formatMessage(fipaMessage) {
    const timestamp = new Date(fipaMessage._timestamp);
    const sender = fipaMessage.sender?.name || 'unknown';
    const performative = fipaMessage.performative;

    // Extract clean content
    let content = this._extractContent(fipaMessage);

    // Add mention for direct messages (skip for broadcasts)
    const receivers = Array.isArray(fipaMessage.receiver)
      ? fipaMessage.receiver
      : [fipaMessage.receiver];

    // Don't add @mention for broadcasts (multiple receivers) or @all
    const isBroadcast = receivers.length > 1 || fipaMessage.isBroadcast?.();
    if (!isBroadcast && receivers.length === 1) {
      const target = receivers[0]?.name;
      // Skip if target starts with @ (like @all) or content already mentions target
      if (target && !target.startsWith('@') && !content.includes(`@${target}`)) {
        content = `@${target} ${content}`;
      }
    }

    return {
      id: fipaMessage._id,
      timestamp,
      sender,
      performative,
      content,
      style: this._getStyle(performative),
    };
  }

  _extractContent(message) {
    const content = message.content;

    if (typeof content === 'string') return content;
    if (typeof content === 'object') {
      if (content.text) return content.text;
      if (content.message) return content.message;
      if (content.action) return content.action;
      if (content.task) return typeof content.task === 'string' ? content.task : JSON.stringify(content.task);
      if (content.result) return `Result: ${JSON.stringify(content.result)}`;
      if (content.reason) return content.reason;
      if (content.error) return `Error: ${content.error}`;
      return JSON.stringify(content);
    }
    return String(content);
  }

  _getStyle(performative) {
    const styles = {
      'request': { fg: '\x1b[36m' },      // cyan
      'inform': { fg: '\x1b[37m' },       // white
      'query-if': { fg: '\x1b[33m' },     // yellow
      'query-ref': { fg: '\x1b[33m' },    // yellow
      'cfp': { fg: '\x1b[1;35m' },        // bold magenta
      'propose': { fg: '\x1b[34m' },      // blue
      'accept-proposal': { fg: '\x1b[32m' }, // green
      'reject-proposal': { fg: '\x1b[31m' }, // red
      'agree': { fg: '\x1b[32m' },        // green
      'refuse': { fg: '\x1b[31m' },       // red
      'failure': { fg: '\x1b[1;31m' },    // bold red
      'not-understood': { fg: '\x1b[2;33m' }, // dim yellow
      'subscribe': { fg: '\x1b[36m' },    // cyan
      'cancel': { fg: '\x1b[90m' },       // gray
    };
    return styles[performative] || { fg: '\x1b[37m' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Rendering to lines array
  // ═══════════════════════════════════════════════════════════════════════════

  _render() {
    this.lines = [];
    this.plainLines = [];

    // Calculate dynamic nick width from participants
    this._updateNickWidth();

    // Header
    this._renderHeader();

    // Messages
    for (const msg of this.messages) {
      this._renderMessage(msg);
    }

    // Input line
    this._renderInputLine();
  }

  /**
   * Calculate max nick width from all participants + available agents
   */
  _updateNickWidth() {
    let maxLen = 4; // minimum "user"

    // From messages
    for (const msg of this.messages) {
      if (msg.sender && msg.sender.length > maxLen) {
        maxLen = msg.sender.length;
      }
    }

    // From available agents
    const agents = this._getAvailableAgents();
    for (const agent of agents) {
      if (agent.id && agent.id.length > maxLen) {
        maxLen = agent.id.length;
      }
    }

    // Add padding, cap at reasonable max
    this.maxNickWidth = Math.min(maxLen + 1, 16);
  }

  _renderHeader() {
    const conv = this.conversations.getConversation(this.conversationId);
    const protocol = conv?.protocol?.name || 'chat';
    const participants = conv?.getSummary()?.participants?.length || 0;
    const status = conv?.isComplete ? ' [ended]' : '';

    const header = `─── #${protocol} (${participants} agents)${status} ───`;
    this.lines.push(`\x1b[90m${header}\x1b[0m`);
    this.plainLines.push(header);
  }

  _renderMessage(msg) {
    // Format: "HH:MM sender   │ content"
    const time = this.showTimestamps ? this._formatTime(msg.timestamp) + ' ' : '';
    const sender = msg.sender.slice(0, this.maxNickWidth).padEnd(this.maxNickWidth);
    const style = msg.style;

    // Calculate content width - use full available width
    const prefixWidth = time.length + this.maxNickWidth + 3; // " │ "
    const contentWidth = Math.max(20, this.width - prefixWidth);

    // Wrap content
    const contentLines = this._wrapText(msg.content, contentWidth);

    // First line with sender
    const firstContent = contentLines[0] || '';
    this.lines.push(
      `\x1b[90m${time}\x1b[36m${sender}\x1b[90m │\x1b[0m ${style.fg}${firstContent}\x1b[0m`
    );
    this.plainLines.push(`${time}${sender} │ ${firstContent}`);

    // Continuation lines
    const padding = ' '.repeat(prefixWidth);
    for (let i = 1; i < contentLines.length; i++) {
      this.lines.push(`${padding}${style.fg}${contentLines[i]}\x1b[0m`);
      this.plainLines.push(`${padding}${contentLines[i]}`);
    }
  }

  _renderInputLine() {
    // Format: "[PERF] @target: input_" with word-aware wrapping
    const perfColors = {
      'request': '\x1b[36m',
      'inform': '\x1b[37m',
      'query-if': '\x1b[33m',
      'query-ref': '\x1b[33m',
      'cfp': '\x1b[35m',
      'propose': '\x1b[34m',
      'agree': '\x1b[32m',
      'refuse': '\x1b[31m',
      'subscribe': '\x1b[36m',
    };

    const perfColor = perfColors[this.performative] || '\x1b[37m';
    const perfLabel = `[${this.performative.toUpperCase()}]`;

    // Build prefix (for width calculation)
    const targetName = this.targetAgent || '?';
    // Don't add @ prefix if target already starts with @ (like @chat)
    const targetDisplay = targetName.startsWith('@') ? targetName : `@${targetName}`;
    const plainTargetPart = this.targetAgent ? `${targetDisplay}: ` : '<Tab:agent> ';
    const prefixPlain = `${perfLabel} ${plainTargetPart}`;
    const prefixLen = prefixPlain.length;

    // ANSI-styled prefix parts
    const targetPartStyled = this.targetAgent
      ? `\x1b[36m${targetDisplay}\x1b[0m: `
      : '\x1b[2m<Tab:agent>\x1b[0m ';

    // Add separator before input (full width)
    this.lines.push('\x1b[90m' + '─'.repeat(this.width) + '\x1b[0m');
    this.plainLines.push('─'.repeat(this.width));

    // Calculate available width for input text (full width minus prefix)
    const availableWidth = Math.max(10, this.width - prefixLen);

    // Wrap input with cursor tracking
    const { lines: wrappedLines, cursorLine, cursorCol } =
      this._wrapInputWithCursor(this.inputBuffer, availableWidth, this.inputCursor);

    // Store input start line for getCursorPosition()
    this._inputStartLine = this.lines.length;
    this._inputCursorLine = cursorLine;
    this._inputCursorCol = cursorCol;
    this._inputPrefixLen = prefixLen;

    // Render each wrapped line
    for (let i = 0; i < wrappedLines.length; i++) {
      const lineText = wrappedLines[i];
      const isFirstLine = i === 0;
      const isCursorLine = i === cursorLine;

      // Build line content with cursor highlight if needed
      let styledText;
      if (isCursorLine) {
        const before = lineText.slice(0, cursorCol);
        const cursorChar = lineText[cursorCol] || ' ';
        const after = lineText.slice(cursorCol + 1);
        styledText = `${before}\x1b[7m${cursorChar}\x1b[27m${after}`;
      } else {
        styledText = lineText;
      }

      if (isFirstLine) {
        // First line: prefix + content
        const line = `${perfColor}${perfLabel}\x1b[0m ${targetPartStyled}${styledText}`;
        const plainLine = `${prefixPlain}${lineText}`;
        this.lines.push(line);
        this.plainLines.push(plainLine);
      } else {
        // Continuation lines: indent to align with first line's text
        const padding = ' '.repeat(prefixLen);
        this.lines.push(`${padding}${styledText}`);
        this.plainLines.push(`${padding}${lineText}`);
      }
    }
  }

  _formatTime(date) {
    const h = date.getHours().toString().padStart(2, '0');
    const m = date.getMinutes().toString().padStart(2, '0');
    return `${h}:${m}`;
  }

  _wrapText(text, width) {
    if (!text) return [''];
    const lines = [];
    const words = text.split(/\s+/);
    let currentLine = '';

    for (const word of words) {
      if (currentLine.length + word.length + 1 <= width) {
        currentLine += (currentLine ? ' ' : '') + word;
      } else {
        if (currentLine) lines.push(currentLine);
        // Handle words longer than width - hard split
        if (word.length > width) {
          let remaining = word;
          while (remaining.length > width) {
            lines.push(remaining.slice(0, width));
            remaining = remaining.slice(width);
          }
          currentLine = remaining;
        } else {
          currentLine = word;
        }
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines.length ? lines : [''];
  }

  /**
   * Wrap input text with cursor tracking (word-aware)
   * Returns { lines, cursorLine, cursorCol } for multi-line input rendering
   */
  _wrapInputWithCursor(text, width, cursorIndex) {
    if (!text || width <= 0) {
      return { lines: [''], cursorLine: 0, cursorCol: Math.min(cursorIndex, 0) };
    }

    const segments = text.split('\n');
    const lines = [];
    let cursorLine = 0;
    let cursorCol = 0;
    let cursorFound = false;
    let remainingCursor = cursorIndex;

    const wrapSegment = (segment, segCursorIndex) => {
      if (!segment) {
        return { lines: [''], cursorLine: 0, cursorCol: Math.min(segCursorIndex || 0, 0) };
      }

      // Pass 1: Word-aware wrap into lines (reuse _wrapText logic)
      const segLines = [];
      const words = segment.split(/(\s+)/);  // Keep whitespace as tokens
      let currentLine = '';

      for (const token of words) {
        if (!token) continue;

        // Would adding this token overflow?
        if (currentLine.length + token.length > width && currentLine.length > 0) {
          segLines.push(currentLine);
          // Skip leading whitespace on new lines
          if (/^\s+$/.test(token)) {
            currentLine = '';
            continue;
          }
          currentLine = '';
        }

        // Handle tokens longer than width (hard split)
        if (token.length > width && !currentLine) {
          let remaining = token;
          while (remaining.length > width) {
            segLines.push(remaining.slice(0, width));
            remaining = remaining.slice(width);
          }
          currentLine = remaining;
        } else if (token.length > width) {
          // Token too long but line has content - push line first
          segLines.push(currentLine);
          let remaining = token;
          while (remaining.length > width) {
            segLines.push(remaining.slice(0, width));
            remaining = remaining.slice(width);
          }
          currentLine = remaining;
        } else {
          currentLine += token;
        }
      }
      if (currentLine || segLines.length === 0) {
        segLines.push(currentLine);
      }

      if (segCursorIndex === null || segCursorIndex === undefined) {
        return { lines: segLines, cursorLine: 0, cursorCol: 0 };
      }

      // Pass 2: Map cursor index to (line, col) by walking through
      let segCursorLine = 0;
      let segCursorCol = 0;
      let lineIdx = 0;
      let colIdx = 0;

      for (let i = 0; i <= segment.length; i++) {
        if (i === segCursorIndex) {
          segCursorLine = lineIdx;
          segCursorCol = colIdx;
          break;
        }

        if (lineIdx < segLines.length) {
          const line = segLines[lineIdx];
          if (colIdx < line.length) {
            if (segment[i] === line[colIdx]) {
              colIdx++;
            }
          }

          if (colIdx >= line.length && lineIdx < segLines.length - 1) {
            lineIdx++;
            colIdx = 0;
          }
        }
      }

      if (segCursorIndex >= segment.length) {
        segCursorLine = segLines.length - 1;
        segCursorCol = segLines[segLines.length - 1].length;
      }

      return { lines: segLines, cursorLine: segCursorLine, cursorCol: segCursorCol };
    };

    for (const segment of segments) {
      let segCursorIndex = null;
      if (!cursorFound) {
        if (remainingCursor <= segment.length) {
          segCursorIndex = remainingCursor;
          cursorFound = true;
        } else {
          remainingCursor -= segment.length + 1;
        }
      }

      const wrapped = wrapSegment(segment, segCursorIndex);
      if (segCursorIndex !== null && segCursorIndex !== undefined) {
        cursorLine = lines.length + wrapped.cursorLine;
        cursorCol = wrapped.cursorCol;
      }
      lines.push(...wrapped.lines);
    }

    if (!cursorFound && lines.length > 0) {
      cursorLine = lines.length - 1;
      cursorCol = lines[lines.length - 1].length;
    }

    return { lines, cursorLine, cursorCol };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Agent interface
  // ═══════════════════════════════════════════════════════════════════════════

  getContentHeight() {
    return this.lines.length;
  }

  getLine(index) {
    return this.lines[index] || '';
  }

  getLineText(index) {
    return this.plainLines[index] || '';
  }

  getCursorPosition() {
    // Use computed values from _renderInputLine()
    const inputStartLine = this._inputStartLine || (this.lines.length - 1);
    const cursorLine = this._inputCursorLine || 0;
    const cursorCol = this._inputCursorCol || 0;
    const prefixLen = this._inputPrefixLen || 0;

    // Line number in buffer
    const line = inputStartLine + cursorLine;

    // Column: first line includes prefix, continuation lines are just indented
    const col = cursorLine === 0
      ? prefixLen + cursorCol
      : prefixLen + cursorCol;

    return { line, col };
  }

  resize(cols, rows) {
    this.width = cols;
    this._render();
  }

  // No PTY, but called by compositor
  write(data) {
    this.handleInput(data);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Input handling
  // ═══════════════════════════════════════════════════════════════════════════

  handleInput(data) {
    if (this._pasteBuffer) {
      data = this._pasteBuffer + data;
      this._pasteBuffer = '';
    }

    // Bracketed paste: ESC[200~ ... ESC[201~
    if (data.startsWith('\x1b[200~')) {
      const pasteEnd = data.indexOf('\x1b[201~');
      if (pasteEnd === -1) {
        this._pasteBuffer = data;
        return;
      }
      const text = data.slice(6, pasteEnd).replace(/\r\n/g, '\n');
      if (text) {
        this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor) +
                           text +
                           this.inputBuffer.slice(this.inputCursor);
        this.inputCursor += text.length;
        this._render();
        this.emit('data');
      }
      return;
    }

    // Enter - send message
    if (data === '\r' || data === '\n') {
      this.send();
      return;
    }

    // Insert newline (common Alt/Ctrl/Shift+Enter sequences)
    if (
      data === '\x0a' || data === '\x1b\r' || data === '\x1b\n' ||
      data === '\x1b[13;2~' || data === '\x1b[13;5~' || data === '\x1b[13;6~' ||
      data === '\x1b[27;5;13~' || data === '\x1b[27;6;13~'
    ) {
      this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor) +
                         '\n' +
                         this.inputBuffer.slice(this.inputCursor);
      this.inputCursor++;
      this._render();
      this.emit('data');
      return;
    }

    // Backspace
    if (data === '\x7f' || data === '\b') {
      if (this.inputCursor > 0) {
        this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor - 1) +
                           this.inputBuffer.slice(this.inputCursor);
        this.inputCursor--;
        this._render();
        this.emit('data');
      }
      return;
    }

    // Ctrl+W - delete word
    if (data === '\x17') {
      const before = this.inputBuffer.slice(0, this.inputCursor);
      const after = this.inputBuffer.slice(this.inputCursor);
      const trimmed = before.replace(/\s*\S+\s*$/, '');
      this.inputBuffer = trimmed + after;
      this.inputCursor = trimmed.length;
      this._render();
      this.emit('data');
      return;
    }

    // Ctrl+U - clear line
    if (data === '\x15') {
      this.inputBuffer = '';
      this.inputCursor = 0;
      this._render();
      this.emit('data');
      return;
    }

    // Tab - cycle target agent
    if (data === '\t') {
      this.cycleTargetAgent(1);
      return;
    }

    // Shift+Tab - cycle backward
    if (data === '\x1b[Z' || data === '\x1b[1;2Z') {
      this.cycleTargetAgent(-1);
      return;
    }

    // Ctrl+P - cycle performative
    if (data === '\x10') {
      this.cyclePerformative();
      return;
    }

    // Word movement
    if (data === '\x1bb' || data === '\x1b[1;3D' || data === '\x1b[3D' || data === '\x1b[1;5D' || data === '\x1b[5D') {
      let pos = this.inputCursor;
      while (pos > 0 && /\s/.test(this.inputBuffer[pos - 1])) pos--;
      while (pos > 0 && /\S/.test(this.inputBuffer[pos - 1])) pos--;
      this.inputCursor = pos;
      this._render();
      this.emit('data');
      return;
    }
    if (data === '\x1bf' || data === '\x1b[1;3C' || data === '\x1b[3C' || data === '\x1b[1;5C' || data === '\x1b[5C') {
      let pos = this.inputCursor;
      while (pos < this.inputBuffer.length && /\S/.test(this.inputBuffer[pos])) pos++;
      while (pos < this.inputBuffer.length && /\s/.test(this.inputBuffer[pos])) pos++;
      this.inputCursor = pos;
      this._render();
      this.emit('data');
      return;
    }

    // Arrow keys
    if (data === '\x1b[D') { // Left
      if (this.inputCursor > 0) {
        this.inputCursor--;
        this._render();
        this.emit('data');
      }
      return;
    }
    if (data === '\x1b[C') { // Right
      if (this.inputCursor < this.inputBuffer.length) {
        this.inputCursor++;
        this._render();
        this.emit('data');
      }
      return;
    }
    if (data === '\x1b[A') { // Up - scroll
      this.scrollUp(1);
      return;
    }
    if (data === '\x1b[B') { // Down - scroll
      this.scrollDown(1);
      return;
    }

    // Regular character
    if (data.length > 1 && !data.startsWith('\x1b')) {
      const clean = data.replace(/\r\n/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
      if (clean) {
        this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor) +
                           clean +
                           this.inputBuffer.slice(this.inputCursor);
        this.inputCursor += clean.length;
        this._render();
        this.emit('data');
      }
      return;
    }
    if (data.length === 1 && data >= ' ') {
      this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor) +
                         data +
                         this.inputBuffer.slice(this.inputCursor);
      this.inputCursor++;
      this._render();
      this.emit('data');
    }
  }

  cycleTargetAgent(direction = 1) {
    // Get all available agents (excluding self/chat agents)
    // Plus special "@chat" broadcast option (for "@chat is this true?" memes)
    const agents = this._getAvailableAgents();
    const targets = [...agents.map(a => a.id), '@chat'];
    if (targets.length === 0) return;

    const currentIdx = targets.indexOf(this.targetAgent);
    let nextIdx;
    if (currentIdx === -1) {
      nextIdx = direction > 0 ? 0 : targets.length - 1;
    } else {
      nextIdx = (currentIdx + direction + targets.length) % targets.length;
    }

    this.targetAgent = targets[nextIdx];
    this._render();
    this.emit('data');
  }

  cyclePerformative() {
    const performatives = ['inform', 'request', 'query-if', 'query-ref', 'cfp', 'propose', 'agree', 'refuse'];
    const idx = performatives.indexOf(this.performative);
    this.performative = performatives[(idx + 1) % performatives.length];
    this._render();
    this.emit('data');
  }

  scrollUp(lines = 1) {
    this.scrollOffset += lines;
    this.autoScroll = false;
    this.emit('data');
  }

  scrollDown(lines = 1) {
    this.scrollOffset = Math.max(0, this.scrollOffset - lines);
    if (this.scrollOffset === 0) this.autoScroll = true;
    this.emit('data');
  }

  send() {
    if (!this.inputBuffer.trim()) return;
    if (!this.targetAgent) return;

    const content = this.inputBuffer.trim();

    // Get source agent (this is a chat, so use a synthetic sender or first real agent)
    const fromAgent = this._getSourceAgent();
    if (!fromAgent) return;

    // Send via FIPA - include conversationId to keep messages in same conversation
    const opts = { conversationId: this.conversationId };

    // Handle @chat broadcast - send to all agents
    const isBroadcast = this.targetAgent === '@chat';
    const targets = isBroadcast
      ? this._getAvailableAgents().map(a => a.id)
      : [this.targetAgent];

    if (targets.length === 0) return;

    try {
      for (const target of targets) {
        switch (this.performative) {
          case 'request':
            this.fipaHub.request(fromAgent.id, target, content, opts);
            break;
          case 'inform':
            this.fipaHub.inform(fromAgent.id, target, content, opts);
            break;
          case 'query-if':
            this.fipaHub.queryIf(fromAgent.id, target, content, opts);
            break;
          case 'query-ref':
            this.fipaHub.queryRef(fromAgent.id, target, content, opts);
            break;
          case 'cfp':
            // CFP broadcasts to all agents except sender
            const others = this._getAvailableAgents().filter(a => a.id !== fromAgent.id);
            if (others.length > 0) {
              this.fipaHub.cfp(fromAgent.id, others.map(a => a.id), content, opts);
            }
            break;
          case 'propose':
            this.fipaHub.propose(fromAgent.id, target, content, opts);
            break;
          case 'agree':
            this.fipaHub.agree(fromAgent.id, target, content, opts);
            break;
          case 'refuse':
            this.fipaHub.refuse(fromAgent.id, target, content, opts);
            break;
          default:
            this.fipaHub.inform(fromAgent.id, target, content, opts);
        }
        // For CFP, we already broadcast - don't loop
        if (this.performative === 'cfp') break;
      }
    } catch (e) {
      // Add error message to chat
      this.messages.push({
        id: Date.now().toString(),
        timestamp: new Date(),
        sender: 'system',
        performative: 'failure',
        content: `Error: ${e.message}`,
        style: { fg: '\x1b[31m' }
      });
    }

    // Clear input
    this.inputBuffer = '';
    this.inputCursor = 0;
    this._render();
    this.emit('data');
  }

  _getAvailableAgents() {
    // This will be set by multi.js when creating ChatAgent
    return this._availableAgents || [];
  }

  _getSourceAgent() {
    // User is the source - messages come FROM user TO agents
    return { id: 'user', name: 'user', type: 'user' };
  }

  setAvailableAgents(agents) {
    const newAgents = agents.filter(a => a.type !== 'chat');
    const oldIds = new Set((this._availableAgents || []).map(a => a.id));

    // Detect newly joined agents
    for (const agent of newAgents) {
      if (!oldIds.has(agent.id)) {
        this._addSystemMessage(`${agent.id} joined the chat`);
      }
    }

    this._availableAgents = newAgents;

    // Auto-select first target if none
    if (!this.targetAgent && this._availableAgents.length > 0) {
      this.targetAgent = this._availableAgents[0].id;
      this._render();
    }
  }

  _addSystemMessage(text) {
    this.messages.push({
      id: `sys-${Date.now()}`,
      timestamp: new Date(),
      sender: '***',
      performative: 'system',
      content: text,
      style: { fg: '\x1b[90m' }  // dim gray
    });
    this._render();
    this.emit('data');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Serialization (for session save)
  // ═══════════════════════════════════════════════════════════════════════════

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: 'chat',
      conversationId: this.conversationId,
    };
  }

  static fromJSON(data, conversationManager, fipaHub) {
    return new ChatAgent(data.conversationId, conversationManager, fipaHub);
  }
}

module.exports = { ChatAgent };
