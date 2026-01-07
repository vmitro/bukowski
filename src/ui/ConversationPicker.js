// src/ui/ConversationPicker.js - Conversation selection overlay
// Shows when :split chat is invoked, to select or start a conversation

const {
  Overlay,
  BOX,
  RESET, DIM, BOLD, REVERSE,
  BG_DARK, BG_DARKER,
  FG_WHITE, FG_GRAY, FG_CYAN
} = require('./Overlay');

/**
 * ConversationPicker
 *
 * List overlay for selecting an existing conversation or starting new.
 * Used when creating a new chat pane.
 *
 * Visual:
 * ┌─ Select Conversation ────────────────┐
 * │ > [NEW] Start new conversation       │
 * │   #chat abc12 (3 msgs) ●             │
 * │   #request def34 (5 msgs) ○          │
 * └─ j/k:move Enter:select Esc:cancel ───┘
 */
class ConversationPicker extends Overlay {
  constructor(config) {
    const conversations = config.conversations || [];
    super({
      ...config,
      title: config.title || 'Select Conversation',
      height: Math.min(conversations.length + 4, 15)  // +1 for "new" option
    });

    this.conversationManager = config.conversationManager;
    this.conversations = conversations;
    this.selectedIndex = 0;  // 0 = "New", 1+ = existing conversations
    this.agents = config.agents || [];  // For starting new conversation

    // Adjust height
    this.bounds.height = Math.min(this.conversations.length + 4, 15);
  }

  /**
   * Handle input for list navigation
   * @param {string} data
   * @returns {Object}
   */
  handleInput(data) {
    const totalItems = this.conversations.length + 1;  // +1 for "New"

    // j/down - next
    if (data === 'j' || data === '\x1b[B') {
      this.selectedIndex = (this.selectedIndex + 1) % totalItems;
      return { action: 'picker_move' };
    }

    // k/up - prev
    if (data === 'k' || data === '\x1b[A') {
      this.selectedIndex = this.selectedIndex <= 0
        ? totalItems - 1
        : this.selectedIndex - 1;
      return { action: 'picker_move' };
    }

    // Enter - select
    if (data === '\r' || data === '\n') {
      if (this.selectedIndex === 0) {
        // New conversation
        return {
          action: 'conversation_new',
          agents: this.agents
        };
      } else {
        // Existing conversation
        const conv = this.conversations[this.selectedIndex - 1];
        return {
          action: 'conversation_select',
          conversationId: conv.id,
          conversation: conv
        };
      }
    }

    // ESC - cancel
    if (data === '\x1b') {
      return { action: 'picker_cancel' };
    }

    // Number keys 1-9 for quick select
    if (data >= '1' && data <= '9') {
      const idx = parseInt(data) - 1;
      if (idx < totalItems) {
        this.selectedIndex = idx;
        // Trigger selection immediately
        if (idx === 0) {
          return { action: 'conversation_new', agents: this.agents };
        } else {
          const conv = this.conversations[idx - 1];
          return {
            action: 'conversation_select',
            conversationId: conv.id,
            conversation: conv
          };
        }
      }
    }

    return { action: 'noop' };
  }

  /**
   * Render the conversation picker
   * @returns {Array}
   */
  render() {
    const lines = [];
    const { x, y, width, height } = this.bounds;

    // Header
    lines.push({
      row: y,
      col: x,
      content: this._renderHeader()
    });

    // List content
    const listHeight = height - 2;
    const totalItems = this.conversations.length + 1;
    const scrollOffset = Math.max(0, this.selectedIndex - listHeight + 2);

    for (let i = 0; i < listHeight; i++) {
      const itemIdx = scrollOffset + i;
      lines.push({
        row: y + 1 + i,
        col: x,
        content: this._renderLine(itemIdx)
      });
    }

    // Footer
    lines.push({
      row: y + height - 1,
      col: x,
      content: this._renderFooter()
    });

    return lines;
  }

  /**
   * Render header
   * @private
   */
  _renderHeader() {
    const width = this.bounds.width;
    const title = ` ${this.title} `;
    const padding = width - title.length - 2;

    return `${BG_DARK}${FG_WHITE}${BOX.TL}${BOX.H}${BOLD}${title}${RESET}${BG_DARK}${FG_WHITE}${BOX.H.repeat(Math.max(0, padding))}${BOX.TR}${RESET}`;
  }

  /**
   * Render a list line
   * @private
   */
  _renderLine(idx) {
    const width = this.bounds.width;
    const contentWidth = width - 4;
    const totalItems = this.conversations.length + 1;

    if (idx >= totalItems) {
      // Empty line
      return `${BG_DARKER}${FG_WHITE}${BOX.V} ${' '.repeat(contentWidth)} ${BOX.V}${RESET}`;
    }

    const isSelected = idx === this.selectedIndex;
    const bg = isSelected ? '\x1b[48;5;240m' : BG_DARKER;
    const fg = isSelected ? '\x1b[97m' : FG_WHITE;
    const marker = isSelected ? '>' : ' ';
    const num = idx < 9 ? `${idx + 1}.` : '  ';

    if (idx === 0) {
      // "New conversation" option
      const label = `${marker} ${num} \x1b[32m[NEW]\x1b[0m${bg}${fg} Start new conversation`;
      const fullLabel = this._stripAnsi(label).padEnd(contentWidth);
      return `${bg}${fg}${BOX.V} ${marker} ${num} \x1b[32m[NEW]\x1b[0m${bg}${fg} Start new conversation${' '.repeat(Math.max(0, contentWidth - fullLabel.length))} ${BOX.V}${RESET}`;
    }

    // Existing conversation
    const conv = this.conversations[idx - 1];
    const shortId = conv.id.slice(0, 5);
    const protocol = conv.protocol || 'chat';
    const msgCount = conv.messageCount || 0;
    const status = conv.isComplete ? '\x1b[90m○' : '\x1b[32m●';

    const label = `${marker} ${num} #${protocol} ${shortId} (${msgCount} msgs) ${status}`;
    const visibleLen = this._stripAnsi(label).length;
    const padding = Math.max(0, contentWidth - visibleLen);

    return `${bg}${fg}${BOX.V} ${label}${RESET}${bg}${' '.repeat(padding)} ${BOX.V}${RESET}`;
  }

  /**
   * Render footer
   * @private
   */
  _renderFooter() {
    const width = this.bounds.width;
    const hint = ' j/k:move 1-9:quick Enter:select Esc:cancel ';
    const padding = width - hint.length - 2;

    return `${BG_DARK}${FG_GRAY}${BOX.BL}${BOX.H.repeat(Math.max(0, padding))}${hint}${BOX.BR}${RESET}`;
  }

  /**
   * Strip ANSI codes for length calculation
   * @private
   */
  _stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
  }

  /**
   * Get list of conversations from manager
   * @param {Object} conversationManager
   * @returns {Array}
   */
  static getConversationList(conversationManager) {
    const list = [];
    const conversations = conversationManager.getAllConversations?.() || [];

    for (const conv of conversations) {
      const summary = conv.getSummary?.() || {};
      list.push({
        id: conv.id,
        protocol: summary.protocol || conv.protocol?.name || 'chat',
        participants: summary.participants || [],
        messageCount: conv.messages?.length || 0,
        isComplete: conv.isComplete || false,
        lastActivity: conv.updatedAt || conv.createdAt || new Date()
      });
    }

    // Sort by last activity (most recent first)
    return list.sort((a, b) => b.lastActivity - a.lastActivity);
  }
}

module.exports = { ConversationPicker };
