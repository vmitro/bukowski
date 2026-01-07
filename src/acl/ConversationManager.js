// src/acl/ConversationManager.js - Track multi-turn agent dialogues
// Manages conversation state, protocol instances, and message routing

const EventEmitter = require('events');
const { FIPAMessage } = require('./FIPAMessage');
const { createProtocolFromMessage, States } = require('./FIPAProtocols');
const { structuredFormatter } = require('./FIPAPromptFormatter');

/**
 * Conversation Manager
 *
 * Tracks all active conversations between agents, managing:
 * - Protocol state machines
 * - Message history per conversation
 * - Timeout handling
 * - Conversation lifecycle
 *
 * This is the orchestration layer that sits above individual protocols,
 * routing messages to the right protocol instance and tracking state.
 */
class ConversationManager extends EventEmitter {
  constructor(options = {}) {
    super();

    // Active conversations indexed by conversation ID
    this.conversations = new Map();

    // Index of conversations by participant
    this.byParticipant = new Map(); // agentId -> Set<conversationId>

    // Configuration
    this.defaultTimeout = options.defaultTimeout || 30000; // 30s
    this.maxConversations = options.maxConversations || 1000;
    this.formatter = options.formatter || structuredFormatter;

    // Cleanup interval for stale conversations
    this._cleanupInterval = setInterval(() => this._cleanup(), 60000);
  }

  /**
   * Create a new empty conversation (without an initial message)
   * @param {Object} [options]
   * @param {string} [options.id] - Conversation ID (generated if not provided)
   * @param {string} [options.initiator] - Initiator agent ID
   * @param {Object} [options.protocol] - Protocol instance
   * @returns {Conversation}
   */
  createConversation(options = {}) {
    const crypto = require('crypto');

    if (this.conversations.size >= this.maxConversations) {
      this._cleanup(true);
    }

    const id = options.id || crypto.randomUUID();
    const conversation = new Conversation({
      id,
      initiator: options.initiator || 'user',
      protocol: options.protocol || null,
      formatter: this.formatter,
    });

    this.conversations.set(id, conversation);
    this.emit('conversation:started', conversation);

    return conversation;
  }

  /**
   * Start a new conversation with a FIPA message
   * @param {FIPAMessage} message - The initiating message
   * @returns {Conversation}
   */
  startConversation(message) {
    if (this.conversations.size >= this.maxConversations) {
      this._cleanup(true); // Force cleanup oldest
    }

    const conversation = new Conversation({
      id: message.conversationId,
      initiator: message.sender.name,
      protocol: createProtocolFromMessage(message),
      formatter: this.formatter,
    });

    // Track participants
    this._trackParticipant(message.sender.name, conversation.id);
    const receivers = Array.isArray(message.receiver) ? message.receiver : [message.receiver];
    receivers.forEach((r) => this._trackParticipant(r.name, conversation.id));

    // Handle first message
    conversation.addMessage(message);
    if (conversation.protocol) {
      conversation.protocol.handleMessage(message);
    }

    // Set timeout if specified
    if (message.replyBy) {
      conversation.setTimeout(message.replyBy - Date.now());
    } else if (message.expectsResponse()) {
      conversation.setTimeout(this.defaultTimeout);
    }

    this.conversations.set(conversation.id, conversation);
    this.emit('conversation:started', conversation);
    this.emit('message:received', { message, conversation });

    return conversation;
  }

  /**
   * Route an incoming message to its conversation
   * @param {FIPAMessage|Object} message - The message (or JSON)
   * @returns {Conversation|null}
   */
  handleMessage(message) {
    // Ensure it's a FIPAMessage
    if (!(message instanceof FIPAMessage)) {
      message = FIPAMessage.fromJSON(message);
    }

    const conversationId = message.conversationId;
    let conversation = this.conversations.get(conversationId);

    // New conversation if not exists
    if (!conversation) {
      conversation = this.startConversation(message);
      return conversation;
    }

    // De-dup: skip if we've already seen this message ID
    const messageId = message._id;
    if (messageId && conversation.messages.some(m => m._id === messageId)) {
      return conversation;
    }

    // Add message to existing conversation
    conversation.addMessage(message);

    // Update protocol state
    if (conversation.protocol) {
      const handled = conversation.protocol.handleMessage(message);

      if (!handled) {
        this.emit('message:unhandled', { message, conversation });
      }

      // Check for conversation completion
      if (conversation.protocol.isComplete()) {
        conversation.complete();
        this.emit('conversation:completed', conversation);
      }
    }

    this.emit('message:received', { message, conversation });
    return conversation;
  }

  /**
   * Get a conversation by ID
   * @param {string} conversationId
   * @returns {Conversation|null}
   */
  getConversation(conversationId) {
    return this.conversations.get(conversationId) || null;
  }

  /**
   * Get all conversations for a participant
   * @param {string} agentId
   * @returns {Conversation[]}
   */
  getConversationsFor(agentId) {
    const ids = this.byParticipant.get(agentId) || new Set();
    return Array.from(ids)
      .map((id) => this.conversations.get(id))
      .filter(Boolean);
  }

  /**
   * Get active (non-completed) conversations for a participant
   * @param {string} agentId
   * @returns {Conversation[]}
   */
  getActiveConversationsFor(agentId) {
    return this.getConversationsFor(agentId).filter((c) => !c.isComplete);
  }

  /**
   * Get pending messages that need response from an agent
   * @param {string} agentId
   * @returns {Object[]} - Array of { conversation, message, expectedResponses }
   */
  getPendingFor(agentId) {
    const pending = [];

    for (const conversation of this.getActiveConversationsFor(agentId)) {
      const lastMessage = conversation.getLastMessage();
      if (!lastMessage) continue;

      // Check if this agent is expected to respond
      const receivers = Array.isArray(lastMessage.receiver)
        ? lastMessage.receiver
        : [lastMessage.receiver];

      const isRecipient = receivers.some((r) => r.name === agentId);

      if (isRecipient && lastMessage.expectsResponse()) {
        pending.push({
          conversation,
          message: lastMessage,
          expectedResponses: conversation.protocol?.getExpectedPerformatives() || [],
          formatted: this.formatter.format(lastMessage, {
            previousMessages: conversation.messages.slice(0, -1),
          }),
        });
      }
    }

    return pending;
  }

  /**
   * Create a response message
   * @param {string} conversationId
   * @param {string} performative
   * @param {*} content
   * @param {string} senderId
   * @returns {FIPAMessage}
   */
  createResponse(conversationId, performative, content, senderId) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    const lastMessage = conversation.getLastMessage();
    if (!lastMessage) {
      throw new Error(`No message to respond to in conversation: ${conversationId}`);
    }

    return lastMessage.createReply(performative, content, senderId);
  }

  /**
   * Track a participant in a conversation
   * @private
   */
  _trackParticipant(agentId, conversationId) {
    if (!this.byParticipant.has(agentId)) {
      this.byParticipant.set(agentId, new Set());
    }
    this.byParticipant.get(agentId).add(conversationId);
  }

  /**
   * Check if a conversation involves the "user" participant
   * @private
   */
  _conversationInvolvesUser(conversation) {
    for (const message of conversation.messages || []) {
      if (message.sender?.name === 'user') return true;
      const receivers = Array.isArray(message.receiver) ? message.receiver : [message.receiver];
      if (receivers.some(r => r?.name === 'user')) return true;
    }
    return false;
  }

  /**
   * Clean up completed/stale conversations
   * @private
   */
  _cleanup(force = false) {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes

    const toRemove = [];

    for (const [id, conversation] of this.conversations) {
      const age = now - conversation.lastActivity;
      const isStale = age > maxAge;
      const isComplete = conversation.isComplete;

      // Never clean up conversations involving "user" - needed for chat history persistence
      if (this._conversationInvolvesUser(conversation)) continue;

      if ((isComplete && age > 30000) || (isStale && !conversation.protocol?.isActive?.())) {
        toRemove.push(id);
      }
    }

    // Force cleanup: remove oldest if at capacity
    if (force && toRemove.length === 0 && this.conversations.size >= this.maxConversations) {
      const sorted = Array.from(this.conversations.entries())
        .sort((a, b) => a[1].lastActivity - b[1].lastActivity)
        .slice(0, 100); // Remove oldest 100

      sorted.forEach(([id]) => toRemove.push(id));
    }

    toRemove.forEach((id) => {
      const conv = this.conversations.get(id);
      this.conversations.delete(id);

      // Clean up participant index
      for (const [agentId, convIds] of this.byParticipant) {
        convIds.delete(id);
        if (convIds.size === 0) {
          this.byParticipant.delete(agentId);
        }
      }

      this.emit('conversation:removed', conv);
    });
  }

  /**
   * Get conversation statistics
   * @returns {Object}
   */
  getStats() {
    let active = 0;
    let completed = 0;
    let failed = 0;

    for (const conversation of this.conversations.values()) {
      if (conversation.isComplete) {
        if (conversation.protocol?.state === States.COMPLETED) {
          completed++;
        } else {
          failed++;
        }
      } else {
        active++;
      }
    }

    return {
      total: this.conversations.size,
      active,
      completed,
      failed,
      participants: this.byParticipant.size,
    };
  }

  /**
   * Shutdown and cleanup
   */
  shutdown() {
    clearInterval(this._cleanupInterval);
    this.conversations.clear();
    this.byParticipant.clear();
    this.removeAllListeners();
  }

  /**
   * Serialize all conversations for persistence
   * @returns {Object[]}
   */
  toJSON() {
    return Array.from(this.conversations.values()).map(c => c.toJSON());
  }

  /**
   * Restore conversations from JSON
   * @param {Object[]} conversationsJson
   */
  restoreFromJSON(conversationsJson) {
    if (!Array.isArray(conversationsJson)) return;

    for (const json of conversationsJson) {
      const conversation = Conversation.fromJSON(json, this.formatter);
      this.conversations.set(conversation.id, conversation);

      // Rebuild participant index
      for (const message of conversation.messages) {
        this._trackParticipant(message.sender.name, conversation.id);
        const receivers = Array.isArray(message.receiver) ? message.receiver : [message.receiver];
        receivers.forEach(r => this._trackParticipant(r.name, conversation.id));
      }
    }
  }
}

/**
 * Conversation
 *
 * Represents a single multi-turn dialogue between agents
 */
class Conversation {
  constructor({ id, initiator, protocol, formatter }) {
    this.id = id;
    this.initiator = initiator;
    this.protocol = protocol;
    this.formatter = formatter;
    this.messages = [];
    this.startTime = Date.now();
    this.lastActivity = Date.now();
    this.isComplete = false;
    this._timeout = null;
  }

  /**
   * Add a message to the conversation
   * @param {FIPAMessage} message
   */
  addMessage(message) {
    this.messages.push(message);
    this.lastActivity = Date.now();
    this.clearTimeout();
  }

  /**
   * Get the last message in the conversation
   * @returns {FIPAMessage|null}
   */
  getLastMessage() {
    return this.messages[this.messages.length - 1] || null;
  }

  /**
   * Get messages from a specific sender
   * @param {string} senderId
   * @returns {FIPAMessage[]}
   */
  getMessagesFrom(senderId) {
    return this.messages.filter((m) => m.sender.name === senderId);
  }

  /**
   * Set a timeout for the conversation
   * @param {number} ms
   */
  setTimeout(ms) {
    this.clearTimeout();
    this._timeout = setTimeout(() => {
      if (!this.isComplete) {
        this.complete('timeout');
      }
    }, ms);
  }

  /**
   * Clear the conversation timeout
   */
  clearTimeout() {
    if (this._timeout) {
      clearTimeout(this._timeout);
      this._timeout = null;
    }
  }

  /**
   * Mark conversation as complete
   * @param {string} [reason]
   */
  complete(reason = null) {
    this.isComplete = true;
    this.completedAt = Date.now();
    this.completionReason = reason;
    this.clearTimeout();
  }

  /**
   * Get formatted conversation for LLM context
   * @returns {string}
   */
  getFormattedHistory() {
    return this.messages.map((m, i) => {
      const context = i > 0 ? { previousMessages: this.messages.slice(0, i) } : {};
      return this.formatter.format(m, context);
    }).join('\n\n---\n\n');
  }

  /**
   * Get conversation summary
   * @returns {Object}
   */
  getSummary() {
    return {
      id: this.id,
      initiator: this.initiator,
      protocol: this.protocol?.name || 'unknown',
      state: this.protocol?.state || 'unknown',
      messageCount: this.messages.length,
      duration: Date.now() - this.startTime,
      isComplete: this.isComplete,
      participants: [...new Set(this.messages.flatMap((m) => {
        const receivers = Array.isArray(m.receiver) ? m.receiver : [m.receiver];
        return [m.sender.name, ...receivers.map((r) => r.name)];
      }))],
    };
  }

  /**
   * Serialize conversation for persistence
   * @returns {Object}
   */
  toJSON() {
    return {
      id: this.id,
      initiator: this.initiator,
      messages: this.messages.map(m => m.toJSON()),
      startTime: this.startTime,
      lastActivity: this.lastActivity,
      isComplete: this.isComplete,
      completedAt: this.completedAt,
      completionReason: this.completionReason,
    };
  }

  /**
   * Restore conversation from JSON
   * @param {Object} json
   * @param {Object} formatter
   * @returns {Conversation}
   */
  static fromJSON(json, formatter) {
    const conversation = new Conversation({
      id: json.id,
      initiator: json.initiator,
      protocol: null, // Protocol state is not preserved
      formatter,
    });
    conversation.messages = json.messages.map(m => FIPAMessage.fromJSON(m));
    conversation.startTime = json.startTime;
    conversation.lastActivity = json.lastActivity;
    conversation.isComplete = json.isComplete;
    conversation.completedAt = json.completedAt;
    conversation.completionReason = json.completionReason;
    return conversation;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Conversation Patterns - Common multi-agent interaction templates
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Task delegation pattern using Contract-Net
 *
 * @param {ConversationManager} manager
 * @param {string} initiator - Initiating agent
 * @param {string[]} participants - Potential workers
 * @param {Object} task - Task specification
 * @param {Object} [options]
 * @returns {Promise<Object>} - { winner, result }
 */
async function delegateTask(manager, initiator, participants, task, options = {}) {
  const { FIPAMessage, AgentIdentifier, cfp } = require('./FIPAMessage');
  const { Performatives } = require('./FIPAPerformatives');

  const timeout = options.timeout || 30000;

  // Create CFP message
  const cfpMessage = cfp(
    new AgentIdentifier(initiator),
    participants.map((p) => new AgentIdentifier(p)),
    task,
    Date.now() + timeout
  );

  // Start conversation
  const conversation = manager.startConversation(cfpMessage);

  // Wait for proposals
  return new Promise((resolve, reject) => {
    const proposalTimeout = setTimeout(() => {
      // Evaluate received proposals
      const proposals = conversation.protocol.getProposals();

      if (proposals.size === 0) {
        reject(new Error('No proposals received'));
        return;
      }

      // Let caller select winner (or auto-select first)
      if (options.selector) {
        resolve({ proposals: Array.from(proposals.values()), conversation });
      } else {
        const winner = Array.from(proposals.values())[0];
        resolve({ winner, conversation });
      }
    }, timeout);

    conversation.protocol.on('proposals-received', ({ proposals }) => {
      clearTimeout(proposalTimeout);

      if (options.selector) {
        resolve({ proposals, conversation });
      } else {
        const winner = proposals[0];
        resolve({ winner, conversation });
      }
    });

    conversation.protocol.on('failed', ({ reason }) => {
      clearTimeout(proposalTimeout);
      reject(new Error(`Task delegation failed: ${reason}`));
    });
  });
}

/**
 * Simple request-response pattern
 *
 * @param {ConversationManager} manager
 * @param {string} from - Requesting agent
 * @param {string} to - Target agent
 * @param {string} action - Requested action
 * @param {Object} [options]
 * @returns {Promise<*>} - Result from INFORM message
 */
async function requestAction(manager, from, to, action, options = {}) {
  const { request, AgentIdentifier } = require('./FIPAMessage');
  const timeout = options.timeout || 30000;

  const message = request(new AgentIdentifier(from), new AgentIdentifier(to), action, {
    replyBy: Date.now() + timeout,
  });

  const conversation = manager.startConversation(message);

  return new Promise((resolve, reject) => {
    conversation.protocol.on(States.COMPLETED, ({ result }) => {
      resolve(result);
    });

    conversation.protocol.on(States.REFUSED, ({ reason }) => {
      reject(new Error(`Request refused: ${reason}`));
    });

    conversation.protocol.on(States.FAILED, ({ error }) => {
      reject(new Error(`Request failed: ${error}`));
    });

    conversation.protocol.on('timeout', () => {
      reject(new Error('Request timed out'));
    });
  });
}

module.exports = {
  ConversationManager,
  Conversation,
  delegateTask,
  requestAction,
};
