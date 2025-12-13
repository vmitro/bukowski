// src/acl/index.js - FIPA ACL Module Exports
// Agent Communication Language implementation for LLM agent coordination

/**
 * FIPA ACL (Foundation for Intelligent Physical Agents - Agent Communication Language)
 *
 * A formal language for agent communication based on speech act theory.
 * This implementation is optimized for LLM agents in the Bukowski multi-agent terminal.
 *
 * Key concepts:
 * - Performatives: The "verbs" of communication (REQUEST, INFORM, PROPOSE, etc.)
 * - Messages: Structured communication with sender, receiver, content, protocol
 * - Protocols: Interaction patterns (Request/Response, Contract-Net, Subscribe)
 * - Conversations: Multi-turn dialogues tracked by conversation ID
 *
 * Why FIPA ACL works well for LLMs:
 * - Performatives map to natural language concepts LLMs already understand
 * - Explicit intent signaling helps LLMs respond appropriately
 * - Protocol awareness gives agents shared expectations
 * - The format is close to how humans communicate intentions
 *
 * Example usage:
 *
 *   const { FIPAHub, Performatives } = require('./acl');
 *
 *   // Send a request
 *   await fipaHub.request('claude-1', 'codex-1', 'Run the test suite');
 *
 *   // Call for proposals
 *   await fipaHub.cfp('manager', ['agent-1', 'agent-2'], {
 *     task: 'Review PR #123',
 *     requirements: ['security focus']
 *   });
 *
 *   // Query another agent
 *   const answer = await fipaHub.queryIf('claude-1', 'codex-1', 'Are the tests passing?');
 */

// Core message types
const { FIPAMessage, AgentIdentifier, request, inform, queryIf, queryRef, cfp, subscribe } = require('./FIPAMessage');

// Performatives (communicative acts)
const {
  Performatives,
  PerformativeSemantics,
  getSemantics,
  isValidPerformative,
  getExpectedResponses,
} = require('./FIPAPerformatives');

// Interaction protocols
const {
  States,
  Protocol,
  FIPARequestProtocol,
  FIPAContractNetProtocol,
  FIPASubscribeProtocol,
  FIPAQueryProtocol,
  createProtocolFromMessage,
} = require('./FIPAProtocols');

// LLM prompt formatting
const {
  FIPAPromptFormatter,
  structuredFormatter,
  naturalFormatter,
  minimalFormatter,
  parseLLMResponse,
} = require('./FIPAPromptFormatter');

// Conversation management
const {
  ConversationManager,
  Conversation,
  delegateTask,
  requestAction,
} = require('./ConversationManager');

// Integration hub
const { FIPAHub } = require('./FIPAHub');

module.exports = {
  // Main hub
  FIPAHub,

  // Messages
  FIPAMessage,
  AgentIdentifier,

  // Message factories
  request,
  inform,
  queryIf,
  queryRef,
  cfp,
  subscribe,

  // Performatives
  Performatives,
  PerformativeSemantics,
  getSemantics,
  isValidPerformative,
  getExpectedResponses,

  // Protocols
  States,
  Protocol,
  FIPARequestProtocol,
  FIPAContractNetProtocol,
  FIPASubscribeProtocol,
  FIPAQueryProtocol,
  createProtocolFromMessage,

  // Formatting
  FIPAPromptFormatter,
  structuredFormatter,
  naturalFormatter,
  minimalFormatter,
  parseLLMResponse,

  // Conversations
  ConversationManager,
  Conversation,
  delegateTask,
  requestAction,
};
