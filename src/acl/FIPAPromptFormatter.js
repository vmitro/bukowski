// src/acl/FIPAPromptFormatter.js - Convert FIPA ACL messages to LLM-readable prompts
// The magic sauce: Makes FIPA ACL intuitive for LLMs through natural language framing

const { Performatives, getSemantics } = require('./FIPAPerformatives');

/**
 * FIPA Prompt Formatter
 *
 * Converts structured FIPA ACL messages into natural language prompts
 * that LLMs can understand and respond to appropriately.
 *
 * The key insight: LLMs already understand speech acts from their training
 * on human conversation. FIPA ACL just formalizes what they already know.
 */
class FIPAPromptFormatter {
  constructor(options = {}) {
    this.style = options.style || 'structured'; // 'structured' | 'natural' | 'minimal'
    this.includeProtocol = options.includeProtocol ?? true;
    this.includeGuidance = options.includeGuidance ?? true;
    this.includeConversationContext = options.includeConversationContext ?? true;
  }

  /**
   * Format a FIPA message for LLM consumption
   * @param {FIPAMessage} message
   * @param {Object} [context] - Additional context (conversation history, etc.)
   * @returns {string}
   */
  format(message, context = {}) {
    switch (this.style) {
      case 'natural':
        return this._formatNatural(message, context);
      case 'minimal':
        return this._formatMinimal(message, context);
      case 'structured':
      default:
        return this._formatStructured(message, context);
    }
  }

  /**
   * Structured format - Clear sections for parsing
   * @private
   */
  _formatStructured(message, context) {
    const sections = [];

    // Header
    sections.push(this._formatHeader(message));

    // Protocol context
    if (this.includeProtocol && message.protocol) {
      sections.push(this._formatProtocolContext(message));
    }

    // Conversation threading
    if (this.includeConversationContext && message.inReplyTo) {
      sections.push(this._formatConversationContext(message, context));
    }

    // Main content
    sections.push(this._formatContent(message));

    // Response guidance
    if (this.includeGuidance) {
      const guidance = this._formatResponseGuidance(message);
      if (guidance) sections.push(guidance);
    }

    return sections.join('\n\n');
  }

  /**
   * Natural language format - Reads like conversation
   * @private
   */
  _formatNatural(message, context) {
    const sender = message.sender.name;
    const intent = this._getIntentPhrase(message.performative);
    const content =
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content, null, 2);

    let text = `${sender} ${intent}:\n\n${content}`;

    if (message.replyBy) {
      const deadline = new Date(message.replyBy).toISOString();
      text += `\n\n(Please respond by ${deadline})`;
    }

    const guidance = this._formatResponseGuidance(message);
    if (guidance) {
      text += `\n\n${guidance}`;
    }

    return text;
  }

  /**
   * Minimal format - Just essentials
   * @private
   */
  _formatMinimal(message, context) {
    const content =
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content);

    return `[${message.performative.toUpperCase()}] ${message.sender.name}: ${content}`;
  }

  /**
   * Format the message header
   * @private
   */
  _formatHeader(message) {
    const performative = message.performative.toUpperCase().replace(/-/g, '_');
    const sender = message.sender.name;
    const receivers = Array.isArray(message.receiver)
      ? message.receiver.map((r) => r.name).join(', ')
      : message.receiver.name;

    return `┌─ FIPA-ACL Message ─────────────────────────────────────────┐
│ Performative: ${performative.padEnd(44)}│
│ From: ${sender.padEnd(52)}│
│ To: ${receivers.padEnd(54)}│
│ Conversation: ${message.conversationId.slice(0, 36).padEnd(44)}│
└────────────────────────────────────────────────────────────┘`;
  }

  /**
   * Format protocol context information
   * @private
   */
  _formatProtocolContext(message) {
    const protocols = {
      'fipa-request':
        'This is a REQUEST protocol interaction. The sender is asking you to perform an action.',
      'fipa-contract-net':
        'This is a CONTRACT-NET negotiation. Multiple agents may be competing to handle this task.',
      'fipa-subscribe':
        'This is a SUBSCRIBE protocol. The sender wants ongoing notifications.',
      'fipa-query':
        'This is a QUERY protocol. The sender is asking for information.',
    };

    const description = protocols[message.protocol] || `Protocol: ${message.protocol}`;

    return `Protocol Context:\n${description}`;
  }

  /**
   * Format conversation context
   * @private
   */
  _formatConversationContext(message, context) {
    let text = `This message is part of conversation: ${message.conversationId}`;

    if (message.inReplyTo) {
      text += `\nIn reply to message: ${message.inReplyTo}`;
    }

    if (context.previousMessages?.length > 0) {
      text += '\n\nConversation history:';
      context.previousMessages.slice(-3).forEach((m, i) => {
        text += `\n  ${i + 1}. [${m.performative}] ${m.sender.name}: ${
          typeof m.content === 'string' ? m.content.slice(0, 50) : '(structured data)'
        }...`;
      });
    }

    return text;
  }

  /**
   * Format the main content
   * @private
   */
  _formatContent(message) {
    const contentType = typeof message.content;
    let formatted;

    if (contentType === 'string') {
      formatted = message.content;
    } else if (contentType === 'object') {
      formatted = JSON.stringify(message.content, null, 2);
    } else {
      formatted = String(message.content);
    }

    const languageNote =
      message.language !== 'natural' ? ` (language: ${message.language})` : '';

    return `Content${languageNote}:\n${'─'.repeat(60)}\n${formatted}\n${'─'.repeat(60)}`;
  }

  /**
   * Format response guidance based on performative
   * @private
   */
  _formatResponseGuidance(message) {
    const semantics = getSemantics(message.performative);
    if (!semantics?.expectedResponses?.length) return null;

    const guidanceMap = {
      [Performatives.REQUEST]: `Expected Response:
You should respond with one of:
  • AGREE - If you will perform the requested action
  • REFUSE - If you cannot or will not perform it (explain why)
  • NOT-UNDERSTOOD - If the request is unclear

After AGREE, you must eventually send:
  • INFORM - With the result of the action
  • FAILURE - If the action could not be completed`,

      [Performatives.QUERY_IF]: `Expected Response:
You should respond with:
  • INFORM-IF - Answer "yes" or "no" to the question
  • REFUSE - If you cannot answer (explain why)
  • NOT-UNDERSTOOD - If the question is unclear`,

      [Performatives.QUERY_REF]: `Expected Response:
You should respond with:
  • INFORM-REF - Provide the requested value/information
  • REFUSE - If you cannot provide the information (explain why)
  • NOT-UNDERSTOOD - If the query is unclear`,

      [Performatives.CFP]: `Expected Response (Contract-Net Protocol):
You are being asked to bid on a task. Respond with:
  • PROPOSE - Submit your proposal with:
    - Your approach/capability for this task
    - Estimated effort or confidence level
    - Any conditions or requirements
  • REFUSE - If you cannot or should not handle this task

Your proposal may be ACCEPTED or REJECTED by the initiator.
If accepted, you must perform the task and send INFORM with results.`,

      [Performatives.PROPOSE]: `Expected Response:
The initiator will respond with:
  • ACCEPT-PROPOSAL - Your proposal was selected
  • REJECT-PROPOSAL - Another proposal was chosen

If accepted, you are committed to performing the proposed action.`,

      [Performatives.INFORM]: `No response required.
This is informational - the sender is sharing knowledge with you.
You may update your understanding based on this information.`,

      [Performatives.AGREE]: `No immediate response required.
The sender has committed to an action. They will follow up with:
  • INFORM - When the action is complete
  • FAILURE - If the action could not be completed`,

      [Performatives.SUBSCRIBE]: `Expected Response:
You should respond with:
  • AGREE - Accept the subscription and send ongoing INFORM messages
  • REFUSE - Decline the subscription (explain why)

While the subscription is active, send INFORM messages when the subscribed condition occurs.`,
    };

    return guidanceMap[message.performative] || null;
  }

  /**
   * Get natural language phrase for performative
   * @private
   */
  _getIntentPhrase(performative) {
    const phrases = {
      [Performatives.INFORM]: 'wants to inform you',
      [Performatives.INFORM_IF]: 'is answering your yes/no question',
      [Performatives.INFORM_REF]: 'is providing the requested information',
      [Performatives.CONFIRM]: 'confirms',
      [Performatives.DISCONFIRM]: 'corrects your understanding',
      [Performatives.REQUEST]: 'is requesting that you',
      [Performatives.REQUEST_WHEN]: 'is requesting that when the condition is met, you',
      [Performatives.REQUEST_WHENEVER]: 'is requesting that whenever the condition occurs, you',
      [Performatives.QUERY_IF]: 'is asking you (yes/no)',
      [Performatives.QUERY_REF]: 'is asking you for',
      [Performatives.AGREE]: 'agrees to',
      [Performatives.REFUSE]: 'refuses, because',
      [Performatives.CANCEL]: 'is cancelling their previous commitment',
      [Performatives.CFP]: 'is calling for proposals on',
      [Performatives.PROPOSE]: 'proposes',
      [Performatives.ACCEPT_PROPOSAL]: 'accepts your proposal',
      [Performatives.REJECT_PROPOSAL]: 'rejects your proposal',
      [Performatives.SUBSCRIBE]: 'wants to subscribe to',
      [Performatives.NOT_UNDERSTOOD]: "didn't understand your message",
      [Performatives.FAILURE]: 'reports failure',
      [Performatives.PROPAGATE]: 'asks you to forward',
      [Performatives.PROXY]: 'asks you to proxy',
    };

    return phrases[performative] || `sends ${performative}`;
  }

  /**
   * Format a response message from an LLM
   * Helps LLMs structure their responses properly
   * @param {string} performative - Response performative
   * @param {*} content - Response content
   * @param {FIPAMessage} originalMessage - Message being replied to
   * @returns {Object} - Message parameters for FIPAMessage constructor
   */
  formatResponse(performative, content, originalMessage) {
    return {
      performative,
      sender: originalMessage.receiver,
      receiver: originalMessage.replyTo || originalMessage.sender,
      content,
      conversationId: originalMessage.conversationId,
      inReplyTo: originalMessage.replyWith || originalMessage._id,
      protocol: originalMessage.protocol,
      ontology: originalMessage.ontology,
      language: originalMessage.language,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pre-built formatters for common use cases
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Structured formatter with full context
 * Best for: Complex multi-agent interactions
 */
const structuredFormatter = new FIPAPromptFormatter({
  style: 'structured',
  includeProtocol: true,
  includeGuidance: true,
  includeConversationContext: true,
});

/**
 * Natural language formatter
 * Best for: Simple, conversational interactions
 */
const naturalFormatter = new FIPAPromptFormatter({
  style: 'natural',
  includeProtocol: false,
  includeGuidance: true,
  includeConversationContext: false,
});

/**
 * Minimal formatter
 * Best for: High-frequency messaging, status updates
 */
const minimalFormatter = new FIPAPromptFormatter({
  style: 'minimal',
  includeProtocol: false,
  includeGuidance: false,
  includeConversationContext: false,
});

// ═══════════════════════════════════════════════════════════════════════════════
// Utility: Parse LLM response into FIPA message
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Attempt to parse an LLM's natural language response into FIPA structure
 * Uses heuristics to identify performative intent
 *
 * @param {string} llmResponse - The LLM's text response
 * @param {FIPAMessage} originalMessage - The message being responded to
 * @returns {Object} - Parsed response with { performative, content, confidence }
 */
function parseLLMResponse(llmResponse, originalMessage) {
  const response = llmResponse.toLowerCase();

  // Check for explicit performative markers
  const explicitPatterns = [
    { pattern: /^\s*\[?agree\]?/i, performative: Performatives.AGREE, confidence: 0.95 },
    { pattern: /^\s*\[?refuse\]?/i, performative: Performatives.REFUSE, confidence: 0.95 },
    { pattern: /^\s*\[?inform\]?/i, performative: Performatives.INFORM, confidence: 0.95 },
    { pattern: /^\s*\[?propose\]?/i, performative: Performatives.PROPOSE, confidence: 0.95 },
    { pattern: /^\s*\[?failure\]?/i, performative: Performatives.FAILURE, confidence: 0.95 },
    {
      pattern: /^\s*\[?not[- ]?understood\]?/i,
      performative: Performatives.NOT_UNDERSTOOD,
      confidence: 0.95,
    },
  ];

  for (const { pattern, performative, confidence } of explicitPatterns) {
    if (pattern.test(llmResponse)) {
      return {
        performative,
        content: llmResponse.replace(pattern, '').trim(),
        confidence,
      };
    }
  }

  // Heuristic detection based on response language
  const heuristics = [
    // Agreement indicators
    {
      patterns: [/\bi('ll| will)\b/, /\byes\b/, /\bsure\b/, /\bof course\b/, /\bstarting\b/],
      performative: Performatives.AGREE,
      confidence: 0.7,
    },
    // Refusal indicators
    {
      patterns: [/\bi (can't|cannot|won't)\b/, /\bno\b/, /\bunable to\b/, /\bsorry\b.*\bcannot\b/],
      performative: Performatives.REFUSE,
      confidence: 0.7,
    },
    // Failure indicators
    {
      patterns: [/\bfailed\b/, /\berror\b/, /\bexception\b/, /\bcouldn't\b/],
      performative: Performatives.FAILURE,
      confidence: 0.6,
    },
    // Proposal indicators
    {
      patterns: [/\bi propose\b/, /\bmy approach\b/, /\bi can (do|handle)\b/, /\bhere's my\b/],
      performative: Performatives.PROPOSE,
      confidence: 0.7,
    },
    // Information indicators
    {
      patterns: [/\bhere (is|are)\b/, /\bthe (result|answer)\b/, /\bfound\b/, /\bcompleted\b/],
      performative: Performatives.INFORM,
      confidence: 0.6,
    },
  ];

  for (const { patterns, performative, confidence } of heuristics) {
    for (const pattern of patterns) {
      if (pattern.test(response)) {
        return {
          performative,
          content: llmResponse,
          confidence,
        };
      }
    }
  }

  // Default: treat as INFORM if responding to REQUEST
  const semantics = getSemantics(originalMessage.performative);
  const defaultPerformative =
    semantics?.expectedResponses?.[0] || Performatives.INFORM;

  return {
    performative: defaultPerformative,
    content: llmResponse,
    confidence: 0.4,
  };
}

module.exports = {
  FIPAPromptFormatter,
  structuredFormatter,
  naturalFormatter,
  minimalFormatter,
  parseLLMResponse,
};
