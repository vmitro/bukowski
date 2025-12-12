// src/ui/ConversationList.js - IRC-style conversation/channel list
// Shows all active FIPA conversations like an IRC channel sidebar

const EventEmitter = require('events');

/**
 * ConversationList
 *
 * Sidebar showing all active conversations, styled like IRC channels:
 *
 *   ┌─ Conversations ─────┐
 *   │ ● #fipa-request     │  <- active, unread
 *   │   #contract-net     │  <- inactive
 *   │ ○ #fipa-query       │  <- completed
 *   │ ! #fipa-request     │  <- awaiting response
 *   └─────────────────────┘
 */
class ConversationList extends EventEmitter {
  constructor(conversationManager) {
    super();
    this.conversations = conversationManager;
    this.selectedIndex = 0;
    this.unread = new Map(); // conversationId -> count

    this._setupListeners();
  }

  /**
   * Setup event listeners
   * @private
   */
  _setupListeners() {
    this.conversations.on('message:received', ({ conversation }) => {
      // Track unread for non-selected conversations
      const current = this.unread.get(conversation.id) || 0;
      this.unread.set(conversation.id, current + 1);
      this.emit('update');
    });

    this.conversations.on('conversation:started', () => {
      this.emit('update');
    });

    this.conversations.on('conversation:completed', () => {
      this.emit('update');
    });
  }

  /**
   * Get sorted list of conversations
   * @returns {Object[]}
   */
  getList() {
    const stats = this.conversations.getStats();
    const list = [];

    for (const [id, conv] of this.conversations.conversations) {
      const summary = conv.getSummary();
      const pending = this.conversations.getPendingFor(conv.initiator);
      const hasPending = pending.some(p => p.conversation.id === id);

      list.push({
        id,
        name: this._getChannelName(conv),
        protocol: summary.protocol,
        state: conv.protocol?.state || 'unknown',
        participants: summary.participants,
        messageCount: summary.messageCount,
        isComplete: conv.isComplete,
        hasPending,
        unread: this.unread.get(id) || 0,
        lastActivity: conv.lastActivity,
      });
    }

    // Sort: pending first, then by activity
    return list.sort((a, b) => {
      if (a.hasPending !== b.hasPending) return a.hasPending ? -1 : 1;
      if (a.isComplete !== b.isComplete) return a.isComplete ? 1 : -1;
      return b.lastActivity - a.lastActivity;
    });
  }

  /**
   * Get channel-style name for conversation
   * @private
   */
  _getChannelName(conversation) {
    const protocol = conversation.protocol?.name || 'chat';
    const shortId = conversation.id.slice(0, 6);

    // Use protocol as channel name, with short ID suffix
    return `#${protocol}-${shortId}`;
  }

  /**
   * Render the conversation list
   * @param {number} width
   * @param {number} height
   * @returns {string[]}
   */
  render(width, height) {
    const lines = [];
    const list = this.getList();

    // Header
    const title = ' Conversations ';
    const headerPad = width - title.length - 2;
    lines.push(`\x1b[48;5;236m\x1b[97m┌─${title}${'─'.repeat(Math.max(0, headerPad))}┐\x1b[0m`);

    // Conversation items
    const listHeight = height - 2;
    const startIdx = Math.max(0, this.selectedIndex - listHeight + 1);

    for (let i = 0; i < listHeight; i++) {
      const idx = startIdx + i;

      if (idx < list.length) {
        const item = list[idx];
        const isSelected = idx === this.selectedIndex;
        lines.push(this._renderItem(item, width, isSelected));
      } else {
        lines.push(`\x1b[48;5;235m│${' '.repeat(width)}│\x1b[0m`);
      }
    }

    // Footer
    lines.push(`\x1b[48;5;236m\x1b[90m└${'─'.repeat(width)}┘\x1b[0m`);

    return lines;
  }

  /**
   * Render single conversation item
   * @private
   */
  _renderItem(item, width, isSelected) {
    // Status indicator
    let indicator;
    if (item.hasPending) {
      indicator = '\x1b[33m!\x1b[0m'; // Yellow ! for awaiting
    } else if (item.isComplete) {
      indicator = '\x1b[90m○\x1b[0m'; // Gray circle for completed
    } else if (item.unread > 0) {
      indicator = '\x1b[32m●\x1b[0m'; // Green dot for unread
    } else {
      indicator = ' ';
    }

    // Channel name (truncated)
    const maxNameWidth = width - 6;
    let name = item.name.slice(0, maxNameWidth);

    // Unread count badge
    let badge = '';
    if (item.unread > 0) {
      badge = `\x1b[33m(${item.unread})\x1b[0m`;
      name = name.slice(0, maxNameWidth - 4);
    }

    // Build line
    const padding = width - name.length - 3 - (item.unread > 0 ? 4 : 0);
    const bg = isSelected ? '\x1b[48;5;238m' : '\x1b[48;5;235m';
    const fg = item.isComplete ? '\x1b[90m' : '\x1b[97m';

    return `${bg}│ ${indicator} ${fg}${name}${badge}${' '.repeat(Math.max(0, padding))}│\x1b[0m`;
  }

  /**
   * Select next conversation
   */
  selectNext() {
    const list = this.getList();
    if (list.length > 0) {
      this.selectedIndex = (this.selectedIndex + 1) % list.length;
      this.emit('selection:changed', list[this.selectedIndex]);
    }
  }

  /**
   * Select previous conversation
   */
  selectPrev() {
    const list = this.getList();
    if (list.length > 0) {
      this.selectedIndex = this.selectedIndex <= 0 ? list.length - 1 : this.selectedIndex - 1;
      this.emit('selection:changed', list[this.selectedIndex]);
    }
  }

  /**
   * Get currently selected conversation
   * @returns {Object|null}
   */
  getSelected() {
    const list = this.getList();
    return list[this.selectedIndex] || null;
  }

  /**
   * Mark conversation as read
   * @param {string} conversationId
   */
  markRead(conversationId) {
    this.unread.delete(conversationId);
    this.emit('update');
  }

  /**
   * Select conversation by ID
   * @param {string} conversationId
   */
  selectById(conversationId) {
    const list = this.getList();
    const idx = list.findIndex(c => c.id === conversationId);
    if (idx >= 0) {
      this.selectedIndex = idx;
      this.emit('selection:changed', list[idx]);
    }
  }
}

module.exports = { ConversationList };
