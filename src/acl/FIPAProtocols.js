// src/acl/FIPAProtocols.js - FIPA Interaction Protocol State Machines
// Based on FIPA Interaction Protocol Library Specification (SC00025H)

const EventEmitter = require('events');
const { Performatives } = require('./FIPAPerformatives');

/**
 * Protocol States - Common states across protocols
 */
const States = {
  INITIATED: 'initiated',
  PENDING: 'pending',
  AGREED: 'agreed',
  REFUSED: 'refused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  // Contract-Net specific
  PROPOSALS_RECEIVED: 'proposals-received',
  PROPOSAL_ACCEPTED: 'proposal-accepted',
  PROPOSAL_REJECTED: 'proposal-rejected',
};

/**
 * Base Protocol class
 * Provides state machine infrastructure for FIPA protocols
 */
class Protocol extends EventEmitter {
  constructor(conversationId, initiator) {
    super();
    this.conversationId = conversationId;
    this.initiator = initiator;
    this.state = States.INITIATED;
    this.messages = [];
    this.startTime = Date.now();
    this.deadline = null;
    this.participants = new Set([initiator]);
    this._timeoutHandle = null;
  }

  /**
   * Add a message to the protocol history
   * @param {FIPAMessage} message
   */
  addMessage(message) {
    this.messages.push({
      message,
      timestamp: Date.now(),
      state: this.state,
    });
  }

  /**
   * Transition to a new state
   * @param {string} newState
   * @param {Object} [data] - Additional event data
   */
  transition(newState, data = {}) {
    const oldState = this.state;
    this.state = newState;
    this.emit('transition', { from: oldState, to: newState, ...data });
    this.emit(newState, data);
  }

  /**
   * Set a timeout for the protocol
   * @param {number} ms - Timeout in milliseconds
   */
  setTimeout(ms) {
    this.deadline = Date.now() + ms;
    this._timeoutHandle = setTimeout(() => {
      this.transition(States.FAILED, { reason: 'timeout' });
      this.emit('timeout');
    }, ms);
  }

  /**
   * Clear the protocol timeout
   */
  clearTimeout() {
    if (this._timeoutHandle) {
      clearTimeout(this._timeoutHandle);
      this._timeoutHandle = null;
    }
  }

  /**
   * Check if protocol is in a terminal state
   * @returns {boolean}
   */
  isComplete() {
    return [States.COMPLETED, States.FAILED, States.CANCELLED, States.REFUSED].includes(
      this.state
    );
  }

  /**
   * Get protocol summary
   * @returns {Object}
   */
  getSummary() {
    return {
      protocol: this.name,
      conversationId: this.conversationId,
      initiator: this.initiator,
      state: this.state,
      participants: Array.from(this.participants),
      messageCount: this.messages.length,
      duration: Date.now() - this.startTime,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIPA-Request Protocol
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * FIPA-Request Protocol
 *
 * Simple request/response interaction:
 *
 * Initiator                    Participant
 *     |                             |
 *     |         REQUEST             |
 *     |---------------------------->|
 *     |                             |
 *     |    AGREE / REFUSE           |
 *     |<----------------------------|
 *     |                             |
 *     |   (if agreed)               |
 *     |                             |
 *     |   INFORM / FAILURE          |
 *     |<----------------------------|
 *     |                             |
 *
 * States: initiated -> pending -> agreed/refused -> completed/failed
 */
class FIPARequestProtocol extends Protocol {
  constructor(conversationId, initiator, participant) {
    super(conversationId, initiator);
    this.name = 'fipa-request';
    this.participant = participant;
    this.participants.add(participant);
    this.request = null;
    this.response = null;
    this.result = null;
  }

  /**
   * Process incoming message according to protocol state
   * @param {FIPAMessage} message
   * @returns {boolean} - Whether message was handled
   */
  handleMessage(message) {
    this.addMessage(message);

    switch (this.state) {
      case States.INITIATED:
        if (message.performative === Performatives.REQUEST) {
          this.request = message;
          this.transition(States.PENDING);
          return true;
        }
        break;

      case States.PENDING:
        if (message.performative === Performatives.AGREE) {
          this.transition(States.AGREED);
          return true;
        }
        if (message.performative === Performatives.REFUSE) {
          this.response = message;
          this.transition(States.REFUSED, { reason: message.content });
          return true;
        }
        if (message.performative === Performatives.NOT_UNDERSTOOD) {
          this.transition(States.FAILED, { reason: message.content });
          return true;
        }
        break;

      case States.AGREED:
        if (message.performative === Performatives.INFORM) {
          this.result = message.content;
          this.transition(States.COMPLETED, { result: message.content });
          return true;
        }
        if (message.performative === Performatives.FAILURE) {
          this.transition(States.FAILED, { error: message.content });
          return true;
        }
        break;
    }

    return false;
  }

  /**
   * Get expected next performatives based on current state
   * @returns {string[]}
   */
  getExpectedPerformatives() {
    switch (this.state) {
      case States.INITIATED:
        return [Performatives.REQUEST];
      case States.PENDING:
        return [Performatives.AGREE, Performatives.REFUSE, Performatives.NOT_UNDERSTOOD];
      case States.AGREED:
        return [Performatives.INFORM, Performatives.FAILURE];
      default:
        return [];
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIPA-Contract-Net Protocol
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * FIPA-Contract-Net Protocol
 *
 * Multi-party negotiation for task delegation:
 *
 * Initiator             Participant-1   Participant-2   Participant-n
 *     |                      |               |               |
 *     |        CFP           |               |               |
 *     |--------------------->|-------------->|-------------->|
 *     |                      |               |               |
 *     |      PROPOSE         |    PROPOSE    |    REFUSE     |
 *     |<---------------------|<--------------|<--------------|
 *     |                      |               |               |
 *     |   ACCEPT-PROPOSAL    | REJECT-PROPOSAL               |
 *     |--------------------->|-------------->|               |
 *     |                      |               |               |
 *     |   INFORM / FAILURE   |               |               |
 *     |<---------------------|               |               |
 *     |                      |               |               |
 *
 * Use cases for LLM agents:
 * - "Who can review this code?" -> Agents propose their capabilities
 * - "Who knows the most about X?" -> Agents bid on expertise
 * - "Need help with Y" -> Agents offer different approaches
 */
class FIPAContractNetProtocol extends Protocol {
  constructor(conversationId, initiator, participants = []) {
    super(conversationId, initiator);
    this.name = 'fipa-contract-net';
    this.cfp = null;
    this.proposals = new Map(); // participantId -> proposal message
    this.refusals = new Map(); // participantId -> refusal message
    this.acceptedProposal = null;
    this.winner = null;
    this.result = null;

    participants.forEach((p) => this.participants.add(p));
  }

  /**
   * Process incoming message according to protocol state
   * @param {FIPAMessage} message
   * @returns {boolean}
   */
  handleMessage(message) {
    this.addMessage(message);
    const senderId = message.sender.name;

    switch (this.state) {
      case States.INITIATED:
        if (message.performative === Performatives.CFP) {
          this.cfp = message;
          this.transition(States.PENDING);
          return true;
        }
        break;

      case States.PENDING:
        if (message.performative === Performatives.PROPOSE) {
          this.proposals.set(senderId, message);
          this._checkProposalDeadline();
          return true;
        }
        if (message.performative === Performatives.REFUSE) {
          this.refusals.set(senderId, message);
          this._checkProposalDeadline();
          return true;
        }
        break;

      case States.PROPOSALS_RECEIVED:
        if (message.performative === Performatives.ACCEPT_PROPOSAL) {
          this.winner = message.receiver.name;
          this.acceptedProposal = this.proposals.get(this.winner);
          this.transition(States.PROPOSAL_ACCEPTED, { winner: this.winner });
          return true;
        }
        if (message.performative === Performatives.REJECT_PROPOSAL) {
          // All rejections handled
          if (this._allProposalsRejected()) {
            this.transition(States.FAILED, { reason: 'all-proposals-rejected' });
          }
          return true;
        }
        break;

      case States.PROPOSAL_ACCEPTED:
        if (message.performative === Performatives.INFORM) {
          this.result = message.content;
          this.transition(States.COMPLETED, { result: message.content });
          return true;
        }
        if (message.performative === Performatives.FAILURE) {
          this.transition(States.FAILED, { error: message.content });
          return true;
        }
        break;
    }

    return false;
  }

  /**
   * Check if all expected proposals/refusals received
   * @private
   */
  _checkProposalDeadline() {
    const totalResponses = this.proposals.size + this.refusals.size;
    const expectedResponses = this.participants.size - 1; // Exclude initiator

    // Check if deadline passed or all responded
    const deadlinePassed = this.deadline && Date.now() >= this.deadline;
    const allResponded = totalResponses >= expectedResponses;

    if (deadlinePassed || allResponded) {
      if (this.proposals.size > 0) {
        this.transition(States.PROPOSALS_RECEIVED, {
          proposals: Array.from(this.proposals.values()),
          refusals: Array.from(this.refusals.values()),
        });
      } else {
        this.transition(States.FAILED, { reason: 'no-proposals' });
      }
    }
  }

  /**
   * Check if all proposals have been rejected
   * @private
   */
  _allProposalsRejected() {
    // Implementation would track reject messages
    return false;
  }

  /**
   * Manually trigger proposal evaluation
   * Call this when you want to evaluate before deadline
   */
  evaluateProposals() {
    if (this.state === States.PENDING && this.proposals.size > 0) {
      this.transition(States.PROPOSALS_RECEIVED, {
        proposals: Array.from(this.proposals.values()),
        refusals: Array.from(this.refusals.values()),
      });
    }
  }

  /**
   * Get all proposals for evaluation
   * @returns {Map}
   */
  getProposals() {
    return this.proposals;
  }

  /**
   * Get expected next performatives
   * @returns {string[]}
   */
  getExpectedPerformatives() {
    switch (this.state) {
      case States.INITIATED:
        return [Performatives.CFP];
      case States.PENDING:
        return [Performatives.PROPOSE, Performatives.REFUSE];
      case States.PROPOSALS_RECEIVED:
        return [Performatives.ACCEPT_PROPOSAL, Performatives.REJECT_PROPOSAL];
      case States.PROPOSAL_ACCEPTED:
        return [Performatives.INFORM, Performatives.FAILURE];
      default:
        return [];
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIPA-Subscribe Protocol
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * FIPA-Subscribe Protocol
 *
 * Establish ongoing notification relationship:
 *
 * Subscriber                  Notifier
 *     |                         |
 *     |       SUBSCRIBE         |
 *     |------------------------>|
 *     |                         |
 *     |   AGREE / REFUSE        |
 *     |<------------------------|
 *     |                         |
 *     |   (while subscribed)    |
 *     |                         |
 *     |       INFORM            |
 *     |<------------------------|
 *     |       INFORM            |
 *     |<------------------------|
 *     |        ...              |
 *     |                         |
 *     |       CANCEL            |
 *     |------------------------>|
 *     |                         |
 *
 * Use cases:
 * - Subscribe to test results
 * - Watch for file changes
 * - Monitor build status
 */
class FIPASubscribeProtocol extends Protocol {
  constructor(conversationId, subscriber, notifier) {
    super(conversationId, subscriber);
    this.name = 'fipa-subscribe';
    this.subscriber = subscriber;
    this.notifier = notifier;
    this.participants.add(notifier);
    this.subscription = null;
    this.notifications = [];
    this.active = false;
  }

  handleMessage(message) {
    this.addMessage(message);

    switch (this.state) {
      case States.INITIATED:
        if (message.performative === Performatives.SUBSCRIBE) {
          this.subscription = message.content;
          this.transition(States.PENDING);
          return true;
        }
        break;

      case States.PENDING:
        if (message.performative === Performatives.AGREE) {
          this.active = true;
          this.transition(States.AGREED);
          return true;
        }
        if (message.performative === Performatives.REFUSE) {
          this.transition(States.REFUSED, { reason: message.content });
          return true;
        }
        break;

      case States.AGREED:
        if (message.performative === Performatives.INFORM) {
          this.notifications.push(message.content);
          this.emit('notification', { content: message.content });
          return true;
        }
        if (message.performative === Performatives.CANCEL) {
          this.active = false;
          this.transition(States.CANCELLED);
          return true;
        }
        break;
    }

    return false;
  }

  getExpectedPerformatives() {
    switch (this.state) {
      case States.INITIATED:
        return [Performatives.SUBSCRIBE];
      case States.PENDING:
        return [Performatives.AGREE, Performatives.REFUSE];
      case States.AGREED:
        return [Performatives.INFORM, Performatives.CANCEL];
      default:
        return [];
    }
  }

  /**
   * Check if subscription is active
   * @returns {boolean}
   */
  isActive() {
    return this.active && this.state === States.AGREED;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIPA-Query Protocol
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * FIPA-Query Protocol
 *
 * Simple query/response for information:
 *
 * Initiator                  Participant
 *     |                          |
 *     |   QUERY-IF / QUERY-REF   |
 *     |------------------------->|
 *     |                          |
 *     | INFORM-IF/REF / REFUSE   |
 *     |<-------------------------|
 *     |                          |
 */
class FIPAQueryProtocol extends Protocol {
  constructor(conversationId, initiator, participant, queryType = 'query-if') {
    super(conversationId, initiator);
    this.name = 'fipa-query';
    this.participant = participant;
    this.participants.add(participant);
    this.queryType = queryType; // 'query-if' or 'query-ref'
    this.query = null;
    this.answer = null;
  }

  handleMessage(message) {
    this.addMessage(message);

    switch (this.state) {
      case States.INITIATED:
        if (
          message.performative === Performatives.QUERY_IF ||
          message.performative === Performatives.QUERY_REF
        ) {
          this.query = message;
          this.queryType = message.performative;
          this.transition(States.PENDING);
          return true;
        }
        break;

      case States.PENDING:
        if (
          message.performative === Performatives.INFORM_IF ||
          message.performative === Performatives.INFORM_REF ||
          message.performative === Performatives.INFORM
        ) {
          this.answer = message.content;
          this.transition(States.COMPLETED, { answer: message.content });
          return true;
        }
        if (message.performative === Performatives.REFUSE) {
          this.transition(States.REFUSED, { reason: message.content });
          return true;
        }
        if (message.performative === Performatives.NOT_UNDERSTOOD) {
          this.transition(States.FAILED, { reason: message.content });
          return true;
        }
        break;
    }

    return false;
  }

  getExpectedPerformatives() {
    switch (this.state) {
      case States.INITIATED:
        return [Performatives.QUERY_IF, Performatives.QUERY_REF];
      case States.PENDING:
        return [
          Performatives.INFORM_IF,
          Performatives.INFORM_REF,
          Performatives.INFORM,
          Performatives.REFUSE,
          Performatives.NOT_UNDERSTOOD,
        ];
      default:
        return [];
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Protocol Factory
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create appropriate protocol instance from message
 * @param {FIPAMessage} message - Initial protocol message
 * @returns {Protocol|null}
 */
function createProtocolFromMessage(message) {
  const protocol = message.protocol;
  const conversationId = message.conversationId;
  const initiator = message.sender.name;

  switch (protocol) {
    case 'fipa-request':
      return new FIPARequestProtocol(
        conversationId,
        initiator,
        Array.isArray(message.receiver) ? message.receiver[0].name : message.receiver.name
      );

    case 'fipa-contract-net':
      return new FIPAContractNetProtocol(
        conversationId,
        initiator,
        Array.isArray(message.receiver) ? message.receiver.map((r) => r.name) : [message.receiver.name]
      );

    case 'fipa-subscribe':
      return new FIPASubscribeProtocol(
        conversationId,
        initiator,
        Array.isArray(message.receiver) ? message.receiver[0].name : message.receiver.name
      );

    case 'fipa-query':
      return new FIPAQueryProtocol(
        conversationId,
        initiator,
        Array.isArray(message.receiver) ? message.receiver[0].name : message.receiver.name,
        message.performative
      );

    default:
      // Try to infer protocol from performative
      switch (message.performative) {
        case Performatives.REQUEST:
          return new FIPARequestProtocol(
            conversationId,
            initiator,
            Array.isArray(message.receiver) ? message.receiver[0].name : message.receiver.name
          );
        case Performatives.CFP:
          return new FIPAContractNetProtocol(
            conversationId,
            initiator,
            Array.isArray(message.receiver) ? message.receiver.map((r) => r.name) : [message.receiver.name]
          );
        case Performatives.SUBSCRIBE:
          return new FIPASubscribeProtocol(
            conversationId,
            initiator,
            Array.isArray(message.receiver) ? message.receiver[0].name : message.receiver.name
          );
        case Performatives.QUERY_IF:
        case Performatives.QUERY_REF:
          return new FIPAQueryProtocol(
            conversationId,
            initiator,
            Array.isArray(message.receiver) ? message.receiver[0].name : message.receiver.name,
            message.performative
          );
        default:
          return null;
      }
  }
}

module.exports = {
  States,
  Protocol,
  FIPARequestProtocol,
  FIPAContractNetProtocol,
  FIPASubscribeProtocol,
  FIPAQueryProtocol,
  createProtocolFromMessage,
};
