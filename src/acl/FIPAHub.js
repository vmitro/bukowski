// src/acl/FIPAHub.js - FIPA ACL integration with IPCHub
// Provides FIPA ACL messaging layer on top of existing Unix socket IPC

const { EventEmitter } = require('events');
const { FIPAMessage, AgentIdentifier, request, inform, queryIf, queryRef, cfp, subscribe } = require('./FIPAMessage');
const { Performatives, getSemantics, getExpectedResponses } = require('./FIPAPerformatives');
const { ConversationManager } = require('./ConversationManager');
const { structuredFormatter, naturalFormatter, minimalFormatter, parseLLMResponse } = require('./FIPAPromptFormatter');
const { States } = require('./FIPAProtocols');

/**
 * FIPA Hub
 *
 * Wraps IPCHub to provide FIPA ACL messaging semantics:
 * - Structured performative-based messages
 * - Conversation tracking and protocol state machines
 * - LLM-friendly message formatting
 * - Automatic response guidance
 *
 * Maintains backward compatibility with existing IAC envelope system.
 */
class FIPAHub extends EventEmitter {
  constructor(ipcHub, options = {}) {
    super();

    this.ipcHub = ipcHub;
    this.session = ipcHub.session;

    // Conversation tracking
    this.conversations = new ConversationManager({
      defaultTimeout: options.defaultTimeout || 30000,
      maxConversations: options.maxConversations || 1000,
      formatter: options.formatter || structuredFormatter,
    });

    // Message formatter for LLM output
    this.formatter = options.formatter || structuredFormatter;

    // Pending FIPA requests (by message ID)
    this.pendingFIPA = new Map();

    // Subscribe to IPC messages
    this._setupIPCListeners();

    // Forward conversation events
    this._setupConversationListeners();
  }

  /**
   * Setup listeners for incoming IPC messages
   * @private
   */
  _setupIPCListeners() {
    this.ipcHub.on('message', (iacMessage) => {
      // Check if this is a FIPA ACL message
      if (this._isFIPAMessage(iacMessage)) {
        this._handleFIPAMessage(iacMessage);
      }
    });

    this.ipcHub.on('agent:connected', (agentId) => {
      this.emit('agent:connected', agentId);
    });

    this.ipcHub.on('agent:disconnected', (agentId) => {
      this.emit('agent:disconnected', agentId);
    });
  }

  /**
   * Setup conversation event forwarding
   * @private
   */
  _setupConversationListeners() {
    this.conversations.on('conversation:started', (conv) => {
      this.emit('conversation:started', conv);
    });

    this.conversations.on('conversation:completed', (conv) => {
      this.emit('conversation:completed', conv);
    });

    this.conversations.on('message:received', ({ message, conversation }) => {
      this.emit('fipa:message', { message, conversation });
    });
  }

  /**
   * Check if an IPC message is a FIPA ACL message
   * @private
   */
  _isFIPAMessage(message) {
    return (
      message.payload?.performative ||
      message.payload?._fipa === true ||
      message.method?.startsWith('fipa:')
    );
  }

  /**
   * Handle incoming FIPA message
   * @private
   */
  _handleFIPAMessage(iacMessage) {
    try {
      // Extract FIPA message from IPC payload
      const fipaData = iacMessage.payload._fipaMessage || iacMessage.payload;

      // Reconstruct FIPAMessage
      const fipaMessage = FIPAMessage.fromJSON({
        performative: fipaData.performative,
        sender: fipaData.sender || iacMessage.from,
        receiver: fipaData.receiver || iacMessage.to,
        content: fipaData.content,
        language: fipaData.language,
        encoding: fipaData.encoding,
        ontology: fipaData.ontology,
        protocol: fipaData.protocol,
        conversationId: fipaData.conversationId || iacMessage.id,
        replyWith: fipaData.replyWith,
        inReplyTo: fipaData.inReplyTo || iacMessage.replyTo,
        replyBy: fipaData.replyBy,
        _id: fipaData._id || iacMessage.id,
        _timestamp: fipaData._timestamp || iacMessage.timestamp,
      });

      // Route to conversation manager
      const conversation = this.conversations.handleMessage(fipaMessage);

      // Check for pending requests to resolve
      if (fipaMessage.inReplyTo && this.pendingFIPA.has(fipaMessage.inReplyTo)) {
        const pending = this.pendingFIPA.get(fipaMessage.inReplyTo);
        clearTimeout(pending.timeout);
        pending.resolve(fipaMessage);
        this.pendingFIPA.delete(fipaMessage.inReplyTo);
      }

      // Emit for external handling
      this.emit('fipa:received', { message: fipaMessage, conversation });

    } catch (err) {
      this.emit('error', err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIPA ACL Message Sending
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Send a FIPA ACL message
   * @param {FIPAMessage} message
   * @returns {Promise<FIPAMessage|null>} - Response if expecting one
   */
  async send(message) {
    const receivers = Array.isArray(message.receiver)
      ? message.receiver.map(r => r.name)
      : [message.receiver.name];

    // Format for LLM consumption
    const formatted = this.formatter.format(message);

    // Create IPC payload
    const payload = {
      _fipa: true,
      _fipaMessage: message.toJSON(),
      _formatted: formatted,
      // Include content at top level for backward compatibility
      ...message.content,
    };

    // Start conversation tracking
    const conversation = this.conversations.startConversation(message);

    // Determine if we should wait for response
    const expectsResponse = message.expectsResponse();

    if (receivers.length === 1) {
      // Single recipient
      if (expectsResponse) {
        return this._sendAndWait(message, payload, receivers[0]);
      } else {
        this.ipcHub.send(
          message.sender.name,
          receivers[0],
          `fipa:${message.performative}`,
          payload,
          this._getSummary(message)
        );
        // Emit for MCP message queue (external agents)
        this.emit('fipa:sent', { message, to: receivers[0], conversation });
        return null;
      }
    } else {
      // Broadcast to multiple recipients
      for (const receiver of receivers) {
        this.ipcHub.send(
          message.sender.name,
          receiver,
          `fipa:${message.performative}`,
          payload,
          this._getSummary(message)
        );
        // Emit for MCP message queue (external agents)
        this.emit('fipa:sent', { message, to: receiver, conversation });
      }
      return null;
    }
  }

  /**
   * Send message and wait for response
   * @private
   */
  _sendAndWait(message, payload, to) {
    const timeout = message.replyBy
      ? message.replyBy - Date.now()
      : 30000;

    return new Promise((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingFIPA.delete(message.replyWith || message._id);
        // Don't reject - just resolve with null and emit timeout event
        this.emit('timeout', { message, to });
        resolve(null);
      }, timeout);

      const waitId = message.replyWith || message._id;
      this.pendingFIPA.set(waitId, {
        resolve,
        reject: () => {}, // No-op reject to avoid crashes
        timeout: timeoutHandle,
        message,
      });

      this.ipcHub.send(
        message.sender.name,
        to,
        `fipa:${message.performative}`,
        payload,
        this._getSummary(message)
      );
    });
  }

  /**
   * Get summary for IAC envelope
   * @private
   */
  _getSummary(message) {
    const summaries = {
      [Performatives.REQUEST]: 'request that you perform an action',
      [Performatives.INFORM]: 'share information with you',
      [Performatives.QUERY_IF]: 'ask you a yes/no question',
      [Performatives.QUERY_REF]: 'ask you for specific information',
      [Performatives.CFP]: 'call for proposals on a task',
      [Performatives.PROPOSE]: 'submit a proposal',
      [Performatives.AGREE]: 'confirm they will do what you asked',
      [Performatives.REFUSE]: 'decline your request',
      [Performatives.SUBSCRIBE]: 'subscribe to notifications',
      [Performatives.FAILURE]: 'report that an action failed',
    };

    return summaries[message.performative] || `send a ${message.performative} message`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Convenience Methods - Common FIPA Patterns
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Send a REQUEST message
   * @param {string} from - Sender agent ID
   * @param {string} to - Receiver agent ID
   * @param {string|Object} action - Action to request
   * @param {Object} [options]
   * @returns {Promise<FIPAMessage>}
   */
  async request(from, to, action, options = {}) {
    const message = request(
      new AgentIdentifier(from),
      new AgentIdentifier(to),
      action,
      options
    );
    return this.send(message);
  }

  /**
   * Send an INFORM message
   * @param {string} from
   * @param {string} to
   * @param {*} information
   * @param {Object} [options]
   */
  async inform(from, to, information, options = {}) {
    const message = inform(
      new AgentIdentifier(from),
      new AgentIdentifier(to),
      information,
      options
    );
    return this.send(message);
  }

  /**
   * Send a QUERY-IF message (yes/no question)
   * @param {string} from
   * @param {string} to
   * @param {string} question
   * @param {Object} [options]
   * @returns {Promise<FIPAMessage>}
   */
  async queryIf(from, to, question, options = {}) {
    const message = queryIf(
      new AgentIdentifier(from),
      new AgentIdentifier(to),
      question,
      options
    );
    return this.send(message);
  }

  /**
   * Send a QUERY-REF message (ask for value)
   * @param {string} from
   * @param {string} to
   * @param {string} reference
   * @param {Object} [options]
   * @returns {Promise<FIPAMessage>}
   */
  async queryRef(from, to, reference, options = {}) {
    const message = queryRef(
      new AgentIdentifier(from),
      new AgentIdentifier(to),
      reference,
      options
    );
    return this.send(message);
  }

  /**
   * Send a CFP (Call For Proposals) to multiple agents
   * @param {string} from
   * @param {string[]} to - Array of potential bidders
   * @param {Object} task - Task specification
   * @param {number} [deadline] - Response deadline (ms from now)
   * @param {Object} [options]
   */
  async cfp(from, to, task, deadline = 30000, options = {}) {
    const message = cfp(
      new AgentIdentifier(from),
      to.map(id => new AgentIdentifier(id)),
      task,
      Date.now() + deadline,
      options
    );
    return this.send(message);
  }

  /**
   * Send a SUBSCRIBE message
   * @param {string} from
   * @param {string} to
   * @param {Object} subscription - What to subscribe to
   * @param {Object} [options]
   * @returns {Promise<FIPAMessage>}
   */
  async subscribe(from, to, subscription, options = {}) {
    const message = subscribe(
      new AgentIdentifier(from),
      new AgentIdentifier(to),
      subscription,
      options
    );
    return this.send(message);
  }

  /**
   * Respond to a FIPA message
   * @param {FIPAMessage} originalMessage - The message to respond to
   * @param {string} performative - Response performative
   * @param {*} content - Response content
   * @param {string} senderId - ID of responding agent
   */
  async respond(originalMessage, performative, content, senderId) {
    const response = originalMessage.createReply(
      performative,
      content,
      new AgentIdentifier(senderId)
    );
    return this.send(response);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Conversation and State Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get pending messages for an agent
   * @param {string} agentId
   * @returns {Object[]}
   */
  getPendingFor(agentId) {
    return this.conversations.getPendingFor(agentId);
  }

  /**
   * Get active conversations for an agent
   * @param {string} agentId
   * @returns {Conversation[]}
   */
  getActiveConversationsFor(agentId) {
    return this.conversations.getActiveConversationsFor(agentId);
  }

  /**
   * Get conversation by ID
   * @param {string} conversationId
   * @returns {Conversation|null}
   */
  getConversation(conversationId) {
    return this.conversations.getConversation(conversationId);
  }

  /**
   * Get conversation statistics
   * @returns {Object}
   */
  getStats() {
    return this.conversations.getStats();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Format for LLM Output
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Format a message for display to an LLM agent
   * @param {FIPAMessage} message
   * @param {Object} [context]
   * @returns {string}
   */
  formatForLLM(message, context = {}) {
    return this.formatter.format(message, context);
  }

  /**
   * Parse an LLM's response into a FIPA message
   * @param {string} llmResponse
   * @param {FIPAMessage} originalMessage
   * @returns {Object}
   */
  parseLLMResponse(llmResponse, originalMessage) {
    return parseLLMResponse(llmResponse, originalMessage);
  }

  /**
   * Set formatter style
   * @param {'structured'|'natural'|'minimal'} style
   */
  setFormatterStyle(style) {
    switch (style) {
      case 'natural':
        this.formatter = naturalFormatter;
        break;
      case 'minimal':
        this.formatter = minimalFormatter;
        break;
      case 'structured':
      default:
        this.formatter = structuredFormatter;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Shutdown FIPA hub
   */
  shutdown() {
    // Clear pending requests
    for (const [id, pending] of this.pendingFIPA) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('FIPA hub shutdown'));
    }
    this.pendingFIPA.clear();

    // Shutdown conversation manager
    this.conversations.shutdown();

    this.removeAllListeners();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Export everything needed for FIPA ACL usage
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  FIPAHub,
  // Re-export core components for convenience
  FIPAMessage,
  AgentIdentifier,
  Performatives,
  States,
  // Formatters
  structuredFormatter,
  naturalFormatter,
  minimalFormatter,
  // Utilities
  parseLLMResponse,
  getSemantics,
  getExpectedResponses,
};
