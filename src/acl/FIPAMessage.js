// src/acl/FIPAMessage.js - FIPA ACL Message Implementation
// Based on FIPA ACL Message Structure Specification (SC00061G)

const crypto = require('crypto');
const { Performatives, isValidPerformative, getSemantics } = require('./FIPAPerformatives');

/**
 * FIPA ACL Message
 *
 * Implements the standard FIPA message structure with extensions
 * for LLM agent communication in the Bukowski multi-agent terminal.
 *
 * Message flow follows speech act theory:
 * - Sender has an intention (performative)
 * - Content carries the proposition/action
 * - Receiver interprets and responds according to protocol
 */
class FIPAMessage {
  /**
   * Create a new FIPA ACL message
   * @param {Object} params
   * @param {string} params.performative - The communicative act (e.g., 'request', 'inform')
   * @param {AgentIdentifier} params.sender - Sending agent
   * @param {AgentIdentifier|AgentIdentifier[]} params.receiver - Receiving agent(s)
   * @param {*} params.content - Message content (any language)
   * @param {Object} [params.options] - Optional FIPA fields
   */
  constructor({ performative, sender, receiver, content, ...options }) {
    // Required fields
    if (!isValidPerformative(performative)) {
      throw new Error(`Invalid performative: ${performative}`);
    }

    this.performative = performative;
    this.sender = AgentIdentifier.from(sender);
    this.receiver = Array.isArray(receiver)
      ? receiver.map((r) => AgentIdentifier.from(r))
      : AgentIdentifier.from(receiver);
    this.content = content;

    // Optional FIPA standard fields
    this.replyTo = options.replyTo ? AgentIdentifier.from(options.replyTo) : null;
    this.language = options.language || 'natural'; // 'natural' | 'json' | 'fipa-sl' | 'javascript'
    this.encoding = options.encoding || 'utf-8';
    this.ontology = options.ontology || 'bukowski-coding-agents';
    this.protocol = options.protocol || null; // 'fipa-request' | 'fipa-contract-net' | etc.
    this.conversationId = options.conversationId || crypto.randomUUID();
    this.replyWith = options.replyWith || null;
    this.inReplyTo = options.inReplyTo || null;
    this.replyBy = options.replyBy || null; // Deadline timestamp

    // Bukowski extensions
    this._id = options._id || crypto.randomUUID();
    this._timestamp = options._timestamp || Date.now();
    this._meta = options._meta || {}; // Additional metadata

    // Validate content requirements
    const semantics = getSemantics(performative);
    if (semantics?.requiresContent && content === undefined) {
      console.warn(`FIPA Warning: ${performative} typically requires content`);
    }
  }

  /**
   * Create a reply to this message
   * @param {string} performative - Response performative
   * @param {*} content - Response content
   * @param {AgentIdentifier} sender - Replying agent
   * @returns {FIPAMessage}
   */
  createReply(performative, content, sender) {
    return new FIPAMessage({
      performative,
      sender,
      receiver: this.replyTo || this.sender,
      content,
      conversationId: this.conversationId,
      inReplyTo: this.replyWith || this._id,
      protocol: this.protocol,
      ontology: this.ontology,
      language: this.language,
    });
  }

  /**
   * Create an AGREE response
   * @param {AgentIdentifier} sender
   * @param {string} [commitment] - Optional commitment statement
   * @returns {FIPAMessage}
   */
  agree(sender, commitment = null) {
    return this.createReply(Performatives.AGREE, commitment, sender);
  }

  /**
   * Create a REFUSE response
   * @param {AgentIdentifier} sender
   * @param {string} reason - Reason for refusal
   * @returns {FIPAMessage}
   */
  refuse(sender, reason) {
    return this.createReply(Performatives.REFUSE, reason, sender);
  }

  /**
   * Create an INFORM response
   * @param {AgentIdentifier} sender
   * @param {*} information - The information to share
   * @returns {FIPAMessage}
   */
  inform(sender, information) {
    return this.createReply(Performatives.INFORM, information, sender);
  }

  /**
   * Create a FAILURE response
   * @param {AgentIdentifier} sender
   * @param {string|Object} error - Failure details
   * @returns {FIPAMessage}
   */
  failure(sender, error) {
    return this.createReply(Performatives.FAILURE, error, sender);
  }

  /**
   * Create a NOT-UNDERSTOOD response
   * @param {AgentIdentifier} sender
   * @param {string} reason - What wasn't understood
   * @returns {FIPAMessage}
   */
  notUnderstood(sender, reason) {
    return this.createReply(Performatives.NOT_UNDERSTOOD, reason, sender);
  }

  /**
   * Create a PROPOSE response (for CFP)
   * @param {AgentIdentifier} sender
   * @param {Object} proposal - The proposal details
   * @returns {FIPAMessage}
   */
  propose(sender, proposal) {
    return this.createReply(Performatives.PROPOSE, proposal, sender);
  }

  /**
   * Check if this message expects a response
   * @returns {boolean}
   */
  expectsResponse() {
    const semantics = getSemantics(this.performative);
    return semantics?.expectedResponses?.length > 0;
  }

  /**
   * Check if a deadline has passed
   * @returns {boolean}
   */
  isExpired() {
    if (!this.replyBy) return false;
    return Date.now() > this.replyBy;
  }

  /**
   * Check if this is a broadcast message
   * @returns {boolean}
   */
  isBroadcast() {
    return Array.isArray(this.receiver) && this.receiver.length > 1;
  }

  /**
   * Serialize to JSON for transport
   * @returns {Object}
   */
  toJSON() {
    return {
      performative: this.performative,
      sender: this.sender.toJSON(),
      receiver: Array.isArray(this.receiver)
        ? this.receiver.map((r) => r.toJSON())
        : this.receiver.toJSON(),
      content: this.content,
      replyTo: this.replyTo?.toJSON() || null,
      language: this.language,
      encoding: this.encoding,
      ontology: this.ontology,
      protocol: this.protocol,
      conversationId: this.conversationId,
      replyWith: this.replyWith,
      inReplyTo: this.inReplyTo,
      replyBy: this.replyBy,
      _id: this._id,
      _timestamp: this._timestamp,
      _meta: this._meta,
    };
  }

  /**
   * Deserialize from JSON
   * @param {Object} json
   * @returns {FIPAMessage}
   */
  static fromJSON(json) {
    return new FIPAMessage({
      performative: json.performative,
      sender: json.sender,
      receiver: json.receiver,
      content: json.content,
      replyTo: json.replyTo,
      language: json.language,
      encoding: json.encoding,
      ontology: json.ontology,
      protocol: json.protocol,
      conversationId: json.conversationId,
      replyWith: json.replyWith,
      inReplyTo: json.inReplyTo,
      replyBy: json.replyBy,
      _id: json._id,
      _timestamp: json._timestamp,
      _meta: json._meta,
    });
  }

  /**
   * Get a human-readable summary
   * @returns {string}
   */
  toString() {
    const receivers = Array.isArray(this.receiver)
      ? this.receiver.map((r) => r.name).join(', ')
      : this.receiver.name;
    return `[${this.performative.toUpperCase()}] ${this.sender.name} -> ${receivers}: ${
      typeof this.content === 'string'
        ? this.content.slice(0, 50)
        : JSON.stringify(this.content).slice(0, 50)
    }...`;
  }
}

/**
 * FIPA Agent Identifier
 *
 * Identifies an agent with name and optional addresses/resolvers
 */
class AgentIdentifier {
  /**
   * @param {string} name - Unique agent name
   * @param {string[]} [addresses] - Transport addresses
   * @param {Object} [resolvers] - Name resolution services
   */
  constructor(name, addresses = [], resolvers = {}) {
    this.name = name;
    this.addresses = addresses;
    this.resolvers = resolvers;
  }

  /**
   * Create from various input formats
   * @param {string|Object|AgentIdentifier} input
   * @returns {AgentIdentifier}
   */
  static from(input) {
    if (input instanceof AgentIdentifier) {
      return input;
    }
    if (typeof input === 'string') {
      return new AgentIdentifier(input);
    }
    if (typeof input === 'object' && input.name) {
      return new AgentIdentifier(input.name, input.addresses, input.resolvers);
    }
    throw new Error(`Cannot create AgentIdentifier from: ${JSON.stringify(input)}`);
  }

  /**
   * Check equality
   * @param {AgentIdentifier} other
   * @returns {boolean}
   */
  equals(other) {
    return this.name === other?.name;
  }

  toJSON() {
    return {
      name: this.name,
      addresses: this.addresses,
      resolvers: this.resolvers,
    };
  }

  toString() {
    return this.name;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Factory functions for common message types
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a REQUEST message
 * @param {AgentIdentifier} sender
 * @param {AgentIdentifier} receiver
 * @param {string} action - Action to perform
 * @param {Object} [options]
 * @returns {FIPAMessage}
 */
function request(sender, receiver, action, options = {}) {
  return new FIPAMessage({
    performative: Performatives.REQUEST,
    sender,
    receiver,
    content: action,
    protocol: 'fipa-request',
    replyWith: crypto.randomUUID(),
    ...options,
  });
}

/**
 * Create an INFORM message
 * @param {AgentIdentifier} sender
 * @param {AgentIdentifier} receiver
 * @param {*} information
 * @param {Object} [options]
 * @returns {FIPAMessage}
 */
function inform(sender, receiver, information, options = {}) {
  return new FIPAMessage({
    performative: Performatives.INFORM,
    sender,
    receiver,
    content: information,
    ...options,
  });
}

/**
 * Create a QUERY-IF message (yes/no question)
 * @param {AgentIdentifier} sender
 * @param {AgentIdentifier} receiver
 * @param {string} question
 * @param {Object} [options]
 * @returns {FIPAMessage}
 */
function queryIf(sender, receiver, question, options = {}) {
  return new FIPAMessage({
    performative: Performatives.QUERY_IF,
    sender,
    receiver,
    content: question,
    protocol: 'fipa-query',
    replyWith: crypto.randomUUID(),
    ...options,
  });
}

/**
 * Create a QUERY-REF message (asking for a value)
 * @param {AgentIdentifier} sender
 * @param {AgentIdentifier} receiver
 * @param {string} reference - What to look up
 * @param {Object} [options]
 * @returns {FIPAMessage}
 */
function queryRef(sender, receiver, reference, options = {}) {
  return new FIPAMessage({
    performative: Performatives.QUERY_REF,
    sender,
    receiver,
    content: reference,
    protocol: 'fipa-query',
    replyWith: crypto.randomUUID(),
    ...options,
  });
}

/**
 * Create a CFP (Call For Proposals) message
 * @param {AgentIdentifier} sender
 * @param {AgentIdentifier[]} receivers - All potential bidders
 * @param {Object} task - Task specification
 * @param {number} [deadline] - Reply deadline timestamp
 * @param {Object} [options]
 * @returns {FIPAMessage}
 */
function cfp(sender, receivers, task, deadline = null, options = {}) {
  return new FIPAMessage({
    performative: Performatives.CFP,
    sender,
    receiver: receivers,
    content: task,
    protocol: 'fipa-contract-net',
    replyWith: crypto.randomUUID(),
    replyBy: deadline,
    ...options,
  });
}

/**
 * Create a SUBSCRIBE message
 * @param {AgentIdentifier} sender
 * @param {AgentIdentifier} receiver
 * @param {Object} subscription - What to subscribe to
 * @param {Object} [options]
 * @returns {FIPAMessage}
 */
function subscribe(sender, receiver, subscription, options = {}) {
  return new FIPAMessage({
    performative: Performatives.SUBSCRIBE,
    sender,
    receiver,
    content: subscription,
    protocol: 'fipa-subscribe',
    ...options,
  });
}

/**
 * Create a PROPOSE message (response to CFP)
 * @param {AgentIdentifier} sender
 * @param {AgentIdentifier} receiver
 * @param {*} proposal - The proposal content
 * @param {Object} [options]
 * @returns {FIPAMessage}
 */
function propose(sender, receiver, proposal, options = {}) {
  return new FIPAMessage({
    performative: Performatives.PROPOSE,
    sender,
    receiver,
    content: proposal,
    ...options,
  });
}

/**
 * Create an AGREE message (accept a request)
 * @param {AgentIdentifier} sender
 * @param {AgentIdentifier} receiver
 * @param {*} [content] - Optional confirmation content
 * @param {Object} [options]
 * @returns {FIPAMessage}
 */
function agree(sender, receiver, content = {}, options = {}) {
  return new FIPAMessage({
    performative: Performatives.AGREE,
    sender,
    receiver,
    content,
    ...options,
  });
}

/**
 * Create a REFUSE message (decline a request)
 * @param {AgentIdentifier} sender
 * @param {AgentIdentifier} receiver
 * @param {string} reason - Reason for refusal
 * @param {Object} [options]
 * @returns {FIPAMessage}
 */
function refuse(sender, receiver, reason, options = {}) {
  return new FIPAMessage({
    performative: Performatives.REFUSE,
    sender,
    receiver,
    content: { reason },
    ...options,
  });
}

module.exports = {
  FIPAMessage,
  AgentIdentifier,
  // Factory functions
  request,
  inform,
  queryIf,
  queryRef,
  cfp,
  subscribe,
  propose,
  agree,
  refuse,
};
