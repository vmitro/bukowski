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

/**
 * @typedef {Object} Bounds
 * @property {number} x - Start column
 * @property {number} y - Start row
 * @property {number} width - Width in columns
 * @property {number} height - Height in rows
 */

module.exports = {};
