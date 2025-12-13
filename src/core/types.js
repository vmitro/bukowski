// src/core/types.js - Type definitions for bukowski multi-agent terminal

/**
 * @typedef {Object} AgentConfig
 * @property {string} id - Unique agent instance ID (e.g., "claude-1", "claude-2")
 * @property {string} name - Display name
 * @property {string} type - Agent type: "claude" | "codex" | "gemini" | "custom"
 * @property {string} command - Executable command
 * @property {string[]} args - Command arguments
 * @property {Object<string,string>} env - Environment variables
 * @property {boolean} autostart - Start on session load
 */

/**
 * @typedef {Object} SessionConfig
 * @property {string} id - Session UUID
 * @property {string} name - Session display name (e.g., "Debug", "Main")
 * @property {AgentConfig[]} agents - Agents in this session
 * @property {LayoutNode} layout - Layout tree for compositor
 * @property {string} createdAt - ISO timestamp
 * @property {string} updatedAt - ISO timestamp
 */

/**
 * @typedef {Object} IACMessage
 * @property {string} id - Message UUID
 * @property {number} timestamp - Unix timestamp ms
 * @property {string} from - Sender agent ID
 * @property {string} to - Recipient agent ID or "*" for broadcast
 * @property {"request"|"response"|"broadcast"} type
 * @property {string} method - e.g., "chat", "execute_code"
 * @property {Object} payload - Method-specific data
 * @property {string} [replyTo] - For responses, the original message ID
 */

/**
 * @typedef {Object} IACEnvelope
 * @property {string} template - Mini-prompt template
 * @property {string} senderName - IAC_AGENT_NAME
 * @property {string} summary - IAC_AGENT_SENDER_SUMMARY
 * @property {string} extended - IAC_AGENT_EXTENDED (full content)
 */

// ═══════════════════════════════════════════════════════════════════════════════
// FIPA ACL Types (Foundation for Intelligent Physical Agents)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * FIPA ACL Performatives - Communicative acts for agent interaction
 * @typedef {'inform'|'inform-if'|'inform-ref'|'confirm'|'disconfirm'|'request'|'request-when'|'request-whenever'|'query-if'|'query-ref'|'agree'|'refuse'|'cancel'|'cfp'|'propose'|'accept-proposal'|'reject-proposal'|'subscribe'|'not-understood'|'failure'|'propagate'|'proxy'} FIPAPerformative
 */

/**
 * FIPA Agent Identifier
 * @typedef {Object} FIPAAgentIdentifier
 * @property {string} name - Unique agent name
 * @property {string[]} [addresses] - Transport addresses
 * @property {Object} [resolvers] - Name resolution services
 */

/**
 * FIPA ACL Message Structure
 * Based on FIPA ACL Message Structure Specification (SC00061G)
 *
 * @typedef {Object} FIPAACLMessage
 * @property {FIPAPerformative} performative - The communicative act
 * @property {FIPAAgentIdentifier} sender - Sending agent
 * @property {FIPAAgentIdentifier|FIPAAgentIdentifier[]} receiver - Receiving agent(s)
 * @property {*} content - Message content (any language)
 * @property {FIPAAgentIdentifier} [replyTo] - Where to send replies
 * @property {'natural'|'json'|'fipa-sl'|'javascript'} [language] - Content language
 * @property {string} [encoding] - Content encoding (e.g., 'utf-8')
 * @property {string} [ontology] - Shared vocabulary/domain concepts
 * @property {'fipa-request'|'fipa-contract-net'|'fipa-subscribe'|'fipa-query'|null} [protocol] - Interaction protocol
 * @property {string} conversationId - Links related messages in a dialogue
 * @property {string} [replyWith] - Expected reply identifier
 * @property {string} [inReplyTo] - What this message replies to
 * @property {number} [replyBy] - Deadline timestamp for reply
 * @property {string} _id - Internal message UUID
 * @property {number} _timestamp - Internal timestamp
 */

/**
 * FIPA Protocol States
 * @typedef {'initiated'|'pending'|'agreed'|'refused'|'completed'|'failed'|'cancelled'|'proposals-received'|'proposal-accepted'|'proposal-rejected'} FIPAProtocolState
 */

/**
 * FIPA Conversation Summary
 * @typedef {Object} FIPAConversationSummary
 * @property {string} id - Conversation UUID
 * @property {string} initiator - Agent who started the conversation
 * @property {string} protocol - Protocol name (e.g., 'fipa-request')
 * @property {FIPAProtocolState} state - Current protocol state
 * @property {number} messageCount - Number of messages in conversation
 * @property {number} duration - Duration in milliseconds
 * @property {boolean} isComplete - Whether conversation has ended
 * @property {string[]} participants - All participating agents
 */

/**
 * @typedef {Object} Bounds
 * @property {number} x - Start column
 * @property {number} y - Start row
 * @property {number} width - Width in columns
 * @property {number} height - Height in rows
 */

module.exports = {};
