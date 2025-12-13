// src/ui/ChatPane.js - IRC-style chat window backed by FIPA ACL
// User sees clean conversation; agents see formatted FIPA prompts

const EventEmitter = require('events');

/**
 * ChatPane
 *
 * IRC-style chat interface for multi-agent conversations.
 * Presents FIPA ACL messages in human-readable format while
 * hiding protocol complexity from the user.
 *
 * Visual style:
 *   ┌─ #code-review (3 agents) ──────────────────────────────┐
 *   │ 14:23 claude-1 │ Who can review PR #123?              │
 *   │ 14:23 codex-1  │ I can handle it with security focus │
 *   │ 14:23 gemini-1 │ I'll focus on performance           │
 *   │ 14:24 claude-1 │ @codex-1 go ahead                   │
 *   │ 14:25 codex-1  │ Done. Found 2 issues: ...           │
 *   └────────────────────────────────────────────────────────┘
 */
class ChatPane extends EventEmitter {
  constructor(conversationManager, options = {}) {
    super();

    this.conversations = conversationManager;
    this.activeConversationId = null;

    // Display options
    this.showTimestamps = options.showTimestamps ?? true;
    this.showPerformatives = options.showPerformatives ?? false; // Hidden by default
    this.timeFormat = options.timeFormat || 'HH:mm';
    this.maxNickWidth = options.maxNickWidth || 12;
    this.colorScheme = options.colorScheme || 'default';

    // Chat history per conversation
    this.chatHistory = new Map(); // conversationId -> ChatMessage[]

    // Scroll state
    this.scrollOffset = 0;
    this.autoScroll = true;

    // Subscribe to conversation events
    this._setupListeners();
  }

  /**
   * Setup conversation event listeners
   * @private
   */
  _setupListeners() {
    this.conversations.on('message:received', ({ message, conversation }) => {
      this._addMessage(conversation.id, message);
    });

    this.conversations.on('conversation:started', (conversation) => {
      this.chatHistory.set(conversation.id, []);
      this.emit('conversation:new', conversation);
    });

    this.conversations.on('conversation:completed', (conversation) => {
      this.emit('conversation:ended', conversation);
    });
  }

  /**
   * Add a FIPA message to chat history
   * @private
   */
  _addMessage(conversationId, fipaMessage) {
    if (!this.chatHistory.has(conversationId)) {
      this.chatHistory.set(conversationId, []);
    }

    const chatMsg = this._formatForChat(fipaMessage);
    this.chatHistory.get(conversationId).push(chatMsg);

    // Auto-scroll if enabled and viewing this conversation
    if (this.autoScroll && this.activeConversationId === conversationId) {
      this.scrollToBottom();
    }

    this.emit('message:added', { conversationId, message: chatMsg });
  }

  /**
   * Convert FIPA message to chat-friendly format
   * @private
   */
  _formatForChat(fipaMessage) {
    const timestamp = new Date(fipaMessage._timestamp);
    const sender = fipaMessage.sender.name;
    const performative = fipaMessage.performative;

    // Extract clean content
    let content = this._extractContent(fipaMessage);

    // Add performative indicator if enabled
    let prefix = '';
    if (this.showPerformatives) {
      prefix = this._getPerformativePrefix(performative);
    }

    // Format mentions (@agent-name)
    const receivers = Array.isArray(fipaMessage.receiver)
      ? fipaMessage.receiver
      : [fipaMessage.receiver];

    if (receivers.length === 1 && !fipaMessage.isBroadcast?.()) {
      const target = receivers[0].name;
      if (!content.includes(`@${target}`)) {
        content = `@${target} ${content}`;
      }
    }

    return {
      id: fipaMessage._id,
      timestamp,
      sender,
      performative,
      content: prefix + content,
      raw: fipaMessage,
      style: this._getMessageStyle(performative),
    };
  }

  /**
   * Extract clean content from FIPA message
   * @private
   */
  _extractContent(message) {
    const content = message.content;

    if (typeof content === 'string') {
      return content;
    }

    if (typeof content === 'object') {
      // Try common content fields
      if (content.text) return content.text;
      if (content.message) return content.message;
      if (content.action) return content.action;
      if (content.task) return typeof content.task === 'string' ? content.task : JSON.stringify(content.task);
      if (content.result) return `Result: ${JSON.stringify(content.result)}`;
      if (content.reason) return content.reason;
      if (content.error) return `Error: ${content.error}`;

      // Fallback to compact JSON
      return JSON.stringify(content);
    }

    return String(content);
  }

  /**
   * Get prefix indicator for performative
   * @private
   */
  _getPerformativePrefix(performative) {
    const prefixes = {
      'request': '? ',
      'inform': 'ℹ ',
      'query-if': '❓ ',
      'query-ref': '❓ ',
      'cfp': '📢 ',
      'propose': '💡 ',
      'accept-proposal': '✓ ',
      'reject-proposal': '✗ ',
      'agree': '👍 ',
      'refuse': '👎 ',
      'failure': '❌ ',
      'not-understood': '❔ ',
      'subscribe': '🔔 ',
      'cancel': '🚫 ',
    };
    return prefixes[performative] || '';
  }

  /**
   * Get message style based on performative
   * @private
   */
  _getMessageStyle(performative) {
    const styles = {
      'request': { fg: 'cyan' },
      'inform': { fg: 'white' },
      'query-if': { fg: 'yellow' },
      'query-ref': { fg: 'yellow' },
      'cfp': { fg: 'magenta', bold: true },
      'propose': { fg: 'blue' },
      'accept-proposal': { fg: 'green' },
      'reject-proposal': { fg: 'red' },
      'agree': { fg: 'green' },
      'refuse': { fg: 'red' },
      'failure': { fg: 'red', bold: true },
      'not-understood': { fg: 'yellow', dim: true },
      'subscribe': { fg: 'cyan' },
      'cancel': { fg: 'gray' },
    };
    return styles[performative] || { fg: 'white' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Rendering
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Render chat pane to array of styled lines
   * @param {number} width - Available width
   * @param {number} height - Available height
   * @returns {string[]} - Array of ANSI-styled lines
   */
  render(width, height) {
    const lines = [];

    // Header
    lines.push(this._renderHeader(width));

    // Chat area (height - 2 for header and input line)
    const chatHeight = height - 2;
    const chatLines = this._renderChat(width - 2, chatHeight);
    lines.push(...chatLines);

    // Input/status line
    lines.push(this._renderStatusLine(width));

    return lines;
  }

  /**
   * Render header bar
   * @private
   */
  _renderHeader(width) {
    const conv = this.activeConversationId
      ? this.conversations.getConversation(this.activeConversationId)
      : null;

    let title = '#lobby';
    let info = '';

    if (conv) {
      const summary = conv.getSummary();
      title = `#${summary.protocol || 'chat'}`;
      info = `(${summary.participants.length} agents)`;

      if (conv.isComplete) {
        info += ' [ended]';
      }
    }

    const titlePart = ` ${title} ${info} `;
    const padding = width - titlePart.length - 2;

    return `\x1b[48;5;236m\x1b[97m┌─${titlePart}${'─'.repeat(Math.max(0, padding))}┐\x1b[0m`;
  }

  /**
   * Render chat messages
   * @private
   */
  _renderChat(width, height) {
    const lines = [];
    const messages = this.activeConversationId
      ? this.chatHistory.get(this.activeConversationId) || []
      : this._getAllRecentMessages(20);

    // Calculate visible messages based on scroll
    const totalLines = this._calculateMessageLines(messages, width);
    const startLine = Math.max(0, totalLines - height - this.scrollOffset);

    let currentLine = 0;
    let renderedLines = 0;

    for (const msg of messages) {
      const msgLines = this._renderMessage(msg, width);

      for (const line of msgLines) {
        if (currentLine >= startLine && renderedLines < height) {
          lines.push(`\x1b[48;5;235m│ ${line}${' '.repeat(Math.max(0, width - this._stripAnsi(line).length))} │\x1b[0m`);
          renderedLines++;
        }
        currentLine++;
      }
    }

    // Fill remaining space
    while (renderedLines < height) {
      lines.push(`\x1b[48;5;235m│${' '.repeat(width + 2)}│\x1b[0m`);
      renderedLines++;
    }

    return lines;
  }

  /**
   * Render single message
   * @private
   */
  _renderMessage(msg, width) {
    const lines = [];

    // Format timestamp
    const time = this.showTimestamps
      ? this._formatTime(msg.timestamp) + ' '
      : '';

    // Format sender (padded)
    const sender = msg.sender.slice(0, this.maxNickWidth).padEnd(this.maxNickWidth);

    // Apply style
    const style = msg.style;
    const fg = this._fgCode(style.fg);
    const attrs = (style.bold ? '\x1b[1m' : '') + (style.dim ? '\x1b[2m' : '');

    // Calculate content width
    const prefixWidth = time.length + this.maxNickWidth + 3; // " │ "
    const contentWidth = width - prefixWidth;

    // Wrap content
    const contentLines = this._wrapText(msg.content, contentWidth);

    // First line with sender
    const firstLine = `\x1b[90m${time}\x1b[36m${sender}\x1b[90m │\x1b[0m ${attrs}${fg}${contentLines[0] || ''}\x1b[0m`;
    lines.push(firstLine);

    // Continuation lines
    for (let i = 1; i < contentLines.length; i++) {
      const padding = ' '.repeat(time.length + this.maxNickWidth + 3);
      lines.push(`${padding}${attrs}${fg}${contentLines[i]}\x1b[0m`);
    }

    return lines;
  }

  /**
   * Render status/input line
   * @private
   */
  _renderStatusLine(width) {
    const conv = this.activeConversationId
      ? this.conversations.getConversation(this.activeConversationId)
      : null;

    let status = '';
    if (conv?.protocol) {
      const state = conv.protocol.state;
      const expected = conv.protocol.getExpectedPerformatives?.() || [];
      if (expected.length > 0) {
        status = `awaiting: ${expected.join(', ')}`;
      } else {
        status = state;
      }
    }

    const statusPart = status ? ` ${status} ` : '';
    const padding = width - statusPart.length - 2;

    return `\x1b[48;5;236m\x1b[90m└${'─'.repeat(Math.max(0, padding))}${statusPart}┘\x1b[0m`;
  }

  /**
   * Get all recent messages across conversations
   * @private
   */
  _getAllRecentMessages(limit) {
    const all = [];

    for (const messages of this.chatHistory.values()) {
      all.push(...messages);
    }

    return all
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-limit);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Navigation
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Set active conversation
   * @param {string} conversationId
   */
  setActiveConversation(conversationId) {
    this.activeConversationId = conversationId;
    this.scrollOffset = 0;
    this.emit('conversation:switched', conversationId);
  }

  /**
   * Cycle to next conversation
   */
  nextConversation() {
    const ids = Array.from(this.chatHistory.keys());
    if (ids.length === 0) return;

    const currentIdx = ids.indexOf(this.activeConversationId);
    const nextIdx = (currentIdx + 1) % ids.length;
    this.setActiveConversation(ids[nextIdx]);
  }

  /**
   * Cycle to previous conversation
   */
  prevConversation() {
    const ids = Array.from(this.chatHistory.keys());
    if (ids.length === 0) return;

    const currentIdx = ids.indexOf(this.activeConversationId);
    const prevIdx = currentIdx <= 0 ? ids.length - 1 : currentIdx - 1;
    this.setActiveConversation(ids[prevIdx]);
  }

  /**
   * Scroll up
   * @param {number} lines
   */
  scrollUp(lines = 1) {
    this.scrollOffset += lines;
    this.autoScroll = false;
  }

  /**
   * Scroll down
   * @param {number} lines
   */
  scrollDown(lines = 1) {
    this.scrollOffset = Math.max(0, this.scrollOffset - lines);
    if (this.scrollOffset === 0) {
      this.autoScroll = true;
    }
  }

  /**
   * Scroll to bottom
   */
  scrollToBottom() {
    this.scrollOffset = 0;
    this.autoScroll = true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Utilities
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Format timestamp
   * @private
   */
  _formatTime(date) {
    const h = date.getHours().toString().padStart(2, '0');
    const m = date.getMinutes().toString().padStart(2, '0');
    return `${h}:${m}`;
  }

  /**
   * Get ANSI foreground color code
   * @private
   */
  _fgCode(color) {
    const codes = {
      black: '\x1b[30m',
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      blue: '\x1b[34m',
      magenta: '\x1b[35m',
      cyan: '\x1b[36m',
      white: '\x1b[37m',
      gray: '\x1b[90m',
    };
    return codes[color] || '\x1b[37m';
  }

  /**
   * Strip ANSI codes from string
   * @private
   */
  _stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
  }

  /**
   * Wrap text to width
   * @private
   */
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
        currentLine = word.length > width ? word.slice(0, width) : word;
      }
    }

    if (currentLine) lines.push(currentLine);
    return lines.length ? lines : [''];
  }

  /**
   * Calculate total lines for messages
   * @private
   */
  _calculateMessageLines(messages, width) {
    let total = 0;
    const prefixWidth = (this.showTimestamps ? 6 : 0) + this.maxNickWidth + 3;
    const contentWidth = width - prefixWidth;

    for (const msg of messages) {
      total += this._wrapText(msg.content, contentWidth).length;
    }

    return total;
  }

  /**
   * Get conversation list for UI
   * @returns {Object[]}
   */
  getConversationList() {
    const list = [];

    for (const [id, messages] of this.chatHistory) {
      const conv = this.conversations.getConversation(id);
      const lastMsg = messages[messages.length - 1];

      list.push({
        id,
        protocol: conv?.protocol?.name || 'chat',
        participants: conv?.getSummary()?.participants || [],
        messageCount: messages.length,
        lastActivity: lastMsg?.timestamp || new Date(0),
        isActive: id === this.activeConversationId,
        isComplete: conv?.isComplete || false,
      });
    }

    return list.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  /**
   * Toggle performative indicators
   */
  togglePerformatives() {
    this.showPerformatives = !this.showPerformatives;
    return this.showPerformatives;
  }

  /**
   * Toggle timestamps
   */
  toggleTimestamps() {
    this.showTimestamps = !this.showTimestamps;
    return this.showTimestamps;
  }
}

module.exports = { ChatPane };
