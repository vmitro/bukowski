// src/mcp/MCPServer.js - MCP Server for FIPA ACL Agent Communication
// Exposes tools for agents to send/receive structured messages

const EventEmitter = require('events');
const net = require('net');
const path = require('path');
const fs = require('fs');

/**
 * MCPServer
 *
 * Model Context Protocol server that exposes FIPA ACL tools to agents.
 * Agents can use these tools to:
 * - Send structured messages (REQUEST, INFORM, QUERY, etc.)
 * - List other connected agents
 * - Poll for pending messages
 *
 * Communication is via Unix socket in /tmp/bukowski-mcp-<pid>.sock
 */
class MCPServer extends EventEmitter {
  constructor(session, fipaHub, ipcHub) {
    super();

    this.session = session;
    this.fipaHub = fipaHub;
    this.ipcHub = ipcHub;

    this.server = null;
    this.socketPath = null;
    this.clients = new Map();  // socket -> { agentId, buffer }

    // Define available tools
    this.tools = this._defineTools();

    // Message queues per agent (for polling)
    this.messageQueues = new Map();  // agentId -> [{...message}]

    // External agents registered via bridge
    // Map: agentId -> { type, registeredAt, socket }
    this.externalAgents = new Map();

    // Counter for generating unique agent IDs
    this.agentCounters = new Map();  // type -> count
  }

  /**
   * Define the FIPA tools available via MCP
   */
  _defineTools() {
    return [
      {
        name: 'fipa_request',
        description: 'Send a REQUEST performative to another agent asking them to perform an action',
        inputSchema: {
          type: 'object',
          required: ['to', 'action'],
          properties: {
            to: { type: 'string', description: 'Target agent ID (e.g., "claude-1", "codex-1")' },
            action: { type: 'string', description: 'The action to request the agent perform' },
            conversationId: { type: 'string', description: 'Optional conversation ID to reply in existing conversation' }
          }
        }
      },
      {
        name: 'fipa_inform',
        description: 'Send an INFORM performative to share information with another agent',
        inputSchema: {
          type: 'object',
          required: ['to', 'content'],
          properties: {
            to: { type: 'string', description: 'Target agent ID' },
            content: { type: 'string', description: 'The information to share' },
            conversationId: { type: 'string', description: 'Optional conversation ID to reply in existing conversation' }
          }
        }
      },
      {
        name: 'fipa_query_if',
        description: 'Send a QUERY-IF performative to ask another agent a yes/no question',
        inputSchema: {
          type: 'object',
          required: ['to', 'proposition'],
          properties: {
            to: { type: 'string', description: 'Target agent ID' },
            proposition: { type: 'string', description: 'The yes/no question to ask' },
            conversationId: { type: 'string', description: 'Optional conversation ID to reply in existing conversation' }
          }
        }
      },
      {
        name: 'fipa_query_ref',
        description: 'Send a QUERY-REF performative to ask another agent for specific information',
        inputSchema: {
          type: 'object',
          required: ['to', 'reference'],
          properties: {
            to: { type: 'string', description: 'Target agent ID' },
            reference: { type: 'string', description: 'Description of the information requested' },
            conversationId: { type: 'string', description: 'Optional conversation ID to reply in existing conversation' }
          }
        }
      },
      {
        name: 'fipa_cfp',
        description: 'Send a Call For Proposals (CFP) to all other agents',
        inputSchema: {
          type: 'object',
          required: ['task'],
          properties: {
            task: { type: 'string', description: 'The task to request proposals for' },
            deadline: { type: 'string', description: 'Optional deadline for proposals' }
          }
        }
      },
      {
        name: 'fipa_propose',
        description: 'Send a PROPOSE performative in response to a CFP',
        inputSchema: {
          type: 'object',
          required: ['to', 'proposal'],
          properties: {
            to: { type: 'string', description: 'Target agent ID (usually the CFP sender)' },
            proposal: { type: 'string', description: 'Your proposal details' },
            conversationId: { type: 'string', description: 'The conversation ID from the CFP' }
          }
        }
      },
      {
        name: 'fipa_agree',
        description: 'Send an AGREE performative to accept a request',
        inputSchema: {
          type: 'object',
          required: ['to', 'conversationId'],
          properties: {
            to: { type: 'string', description: 'Target agent ID' },
            conversationId: { type: 'string', description: 'The conversation ID to agree to' }
          }
        }
      },
      {
        name: 'fipa_refuse',
        description: 'Send a REFUSE performative to decline a request',
        inputSchema: {
          type: 'object',
          required: ['to', 'reason'],
          properties: {
            to: { type: 'string', description: 'Target agent ID' },
            reason: { type: 'string', description: 'Reason for refusal' },
            conversationId: { type: 'string', description: 'The conversation ID to refuse' }
          }
        }
      },
      {
        name: 'list_agents',
        description: 'List all connected agents in the session',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'get_pending_messages',
        description: 'Get pending FIPA messages for this agent',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Maximum number of messages to return (default: 10)' }
          }
        }
      },
      {
        name: 'get_conversations',
        description: 'Get active FIPA conversations this agent is part of',
        inputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['active', 'completed', 'all'], description: 'Filter by status' }
          }
        }
      },
      {
        name: 'register_agent',
        description: 'Register this agent with bukowski (called automatically by bridge)',
        inputSchema: {
          type: 'object',
          required: ['type'],
          properties: {
            type: { type: 'string', description: 'Agent type (claude, codex, gemini, unknown)' }
          }
        }
      }
    ];
  }

  /**
   * Get tools list with dynamic pending message count for agent
   * @private
   */
  _getToolsForAgent(agentId) {
    const pendingCount = (this.messageQueues.get(agentId) || []).length;

    // Return tools with dynamic description for get_pending_messages
    return this.tools.map(tool => {
      if (tool.name === 'get_pending_messages' && pendingCount > 0) {
        return {
          ...tool,
          description: `Get pending FIPA messages for this agent (${pendingCount} pending)`
        };
      }
      return tool;
    });
  }

  /**
   * Get socket path for this server
   */
  getSocketPath() {
    return this.socketPath;
  }

  /**
   * Start the MCP server
   */
  async start() {
    // Create socket path
    this.socketPath = path.join('/tmp', `bukowski-mcp-${process.pid}.sock`);

    // Remove existing socket file if present
    try {
      fs.unlinkSync(this.socketPath);
    } catch (err) {
      // Ignore - file may not exist
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this._handleConnection(socket);
      });

      this.server.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        // Make socket accessible
        try {
          fs.chmodSync(this.socketPath, 0o666);
        } catch (err) {
          // Ignore chmod errors
        }
        this.emit('listening', this.socketPath);
        resolve(this.socketPath);
      });
    });
  }

  /**
   * Stop the MCP server
   */
  stop() {
    if (this.server) {
      // Close all client connections
      for (const [socket] of this.clients) {
        socket.destroy();
      }
      this.clients.clear();

      this.server.close();
      this.server = null;

      // Clean up socket file
      try {
        fs.unlinkSync(this.socketPath);
      } catch (err) {
        // Ignore
      }
    }
  }

  /**
   * Handle a new client connection
   * @private
   */
  _handleConnection(socket) {
    const clientState = {
      agentId: null,
      buffer: ''
    };
    this.clients.set(socket, clientState);

    socket.on('data', (data) => {
      clientState.buffer += data.toString();
      this._processBuffer(socket, clientState);
    });

    socket.on('close', () => {
      this.clients.delete(socket);
    });

    socket.on('error', (err) => {
      this.emit('client_error', err);
      this.clients.delete(socket);
    });
  }

  /**
   * Process incoming data buffer for JSON-RPC messages
   * @private
   */
  _processBuffer(socket, clientState) {
    // Simple newline-delimited JSON
    const lines = clientState.buffer.split('\n');
    clientState.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const request = JSON.parse(line);
        this._handleRequest(socket, clientState, request);
      } catch (err) {
        this._sendError(socket, null, -32700, 'Parse error');
      }
    }
  }

  /**
   * Handle a JSON-RPC request
   * @private
   */
  async _handleRequest(socket, clientState, request) {
    const { id, method, params } = request;

    // Handle MCP protocol methods
    switch (method) {
      case 'initialize': {
        // Agent identifies itself
        // Priority: agentId > ppid match > agentType (external) > null
        let assignedId = null;

        if (params?.agentId) {
          // Explicit session agent ID (from BUKOWSKI_AGENT_ID env)
          assignedId = params.agentId;
        } else if (params?.ancestorPids?.length) {
          // Try to match ancestor PIDs to a session agent's PTY PID
          const ancestorSet = new Set(params.ancestorPids);
          const sessionAgent = this.session.getAllAgents().find(
            a => a.pty && ancestorSet.has(a.pty.pid)
          );
          if (sessionAgent) {
            assignedId = sessionAgent.id;
          }
        }

        if (!assignedId && params?.agentType) {
          // External agent via bridge - assign a unique ID
          assignedId = this._assignAgentId(params.agentType, socket);
        }

        clientState.agentId = assignedId;
        this._sendResult(socket, id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'bukowski-mcp', version: '1.0.0' },
          assignedAgentId: assignedId
        });
        break;
      }

      case 'tools/list':
        this._sendResult(socket, id, { tools: this._getToolsForAgent(clientState.agentId) });
        break;

      case 'tools/call':
        try {
          // Use clientState.agentId, or fallback to _callerAgentId from bridge
          const callerAgentId = clientState.agentId || params.arguments?._callerAgentId || 'unknown';
          const result = await this._handleToolCall(
            params.name,
            params.arguments,
            callerAgentId
          );
          this._sendResult(socket, id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          });
        } catch (err) {
          this._sendError(socket, id, -32000, err.message);
        }
        break;

      default:
        this._sendError(socket, id, -32601, 'Method not found');
    }
  }

  /**
   * Handle a tool call from an agent
   * @param {string} toolName
   * @param {Object} args
   * @param {string} callerAgentId
   */
  async _handleToolCall(toolName, args, callerAgentId) {
    switch (toolName) {
      case 'fipa_request':
        return this._sendFipaMessage('request', callerAgentId, args.to, args.action, args.conversationId);

      case 'fipa_inform':
        return this._sendFipaMessage('inform', callerAgentId, args.to, args.content, args.conversationId);

      case 'fipa_query_if':
        return this._sendFipaMessage('query-if', callerAgentId, args.to, args.proposition, args.conversationId);

      case 'fipa_query_ref':
        return this._sendFipaMessage('query-ref', callerAgentId, args.to, args.reference, args.conversationId);

      case 'fipa_cfp': {
        const recipients = this.session.getAllAgents()
          .filter(a => a.id !== callerAgentId)
          .map(a => a.id);
        return this.fipaHub.cfp(callerAgentId, recipients, {
          task: args.task,
          deadline: args.deadline
        });
      }

      case 'fipa_propose':
        return this._sendFipaMessage('propose', callerAgentId, args.to, args.proposal, args.conversationId);

      case 'fipa_agree':
        return this._sendFipaMessage('agree', callerAgentId, args.to, null, args.conversationId);

      case 'fipa_refuse':
        return this._sendFipaMessage('refuse', callerAgentId, args.to, args.reason, args.conversationId);

      case 'list_agents': {
        // Include both session agents and external agents
        const sessionAgents = this.session.getAllAgents().map(a => ({
          id: a.id,
          name: a.name,
          type: a.type,
          source: 'session'
        }));

        const externalAgents = this.getExternalAgents().map(a => ({
          id: a.id,
          name: a.id,
          type: a.type,
          source: 'external'
        }));

        return [...sessionAgents, ...externalAgents];
      }

      case 'get_pending_messages': {
        const limit = args.limit || 10;
        const queue = this.messageQueues.get(callerAgentId) || [];
        const messages = queue.splice(0, limit);
        return { messages, remaining: queue.length };
      }

      case 'get_conversations': {
        const status = args.status || 'all';
        const conversations = [];
        for (const [convId, conv] of this.fipaHub.conversations) {
          if (conv.from === callerAgentId || conv.to === callerAgentId ||
              (Array.isArray(conv.to) && conv.to.includes(callerAgentId))) {
            if (status === 'all' || conv.state === status) {
              conversations.push({
                id: convId,
                from: conv.from,
                to: conv.to,
                performative: conv.performative,
                state: conv.state,
                messageCount: conv.messages?.length || 0
              });
            }
          }
        }
        return conversations;
      }

      case 'register_agent': {
        // Called by bridge to explicitly register
        // Usually handled in initialize, but can be called manually
        const agentType = args.type || 'unknown';
        // Find the socket for this caller (best effort)
        const agentId = callerAgentId || `${agentType}-ext-${Date.now()}`;
        return { agentId, registered: true };
      }

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  /**
   * Send a FIPA message via FIPAHub
   * @private
   */
  _sendFipaMessage(performative, from, to, content, conversationId = null) {
    if (!this.fipaHub) {
      throw new Error('FIPA Hub not available');
    }

    // Validate target agent exists (session, external, or special "user" identity)
    const sessionAgent = this.session.getAgent(to);
    const externalAgent = this.externalAgents.get(to);
    const isUser = to === 'user';
    if (!sessionAgent && !externalAgent && !isUser) {
      throw new Error(`Unknown agent: ${to}`);
    }

    // Send via FIPAHub - pass conversationId in options if provided
    const opts = conversationId ? { conversationId } : {};
    let result;
    switch (performative) {
      case 'request':
        result = this.fipaHub.request(from, to, content, opts);
        break;
      case 'inform':
        result = this.fipaHub.inform(from, to, content, opts);
        break;
      case 'query-if':
        result = this.fipaHub.queryIf(from, to, content, opts);
        break;
      case 'query-ref':
        result = this.fipaHub.queryRef(from, to, content, opts);
        break;
      case 'propose':
        result = this.fipaHub.propose(from, to, content, opts);
        break;
      case 'agree':
        result = this.fipaHub.agree(from, to, content, opts);
        break;
      case 'refuse':
        result = this.fipaHub.refuse(from, to, content, opts);
        break;
      default:
        // Fall back to inform for unknown performatives
        result = this.fipaHub.inform(from, to, { [performative]: content });
    }

    return { success: true, conversationId: result?.conversationId || null };
  }

  /**
   * Queue an incoming message for an agent to poll
   * @param {string} agentId
   * @param {Object} message
   */
  queueMessage(agentId, message) {
    if (!this.messageQueues.has(agentId)) {
      this.messageQueues.set(agentId, []);
    }
    this.messageQueues.get(agentId).push(message);

    // Limit queue size
    const queue = this.messageQueues.get(agentId);
    if (queue.length > 100) {
      queue.shift();
    }

    // Send notification to the agent
    this.notifyNewMessage(agentId, message);
  }

  /**
   * Assign a unique agent ID for an external agent
   * @private
   * @param {string} agentType - Type of agent (claude, codex, gemini, unknown)
   * @param {net.Socket} socket - The socket connection
   * @returns {string} Assigned agent ID
   */
  _assignAgentId(agentType, socket) {
    // Get next number for this agent type
    const count = (this.agentCounters.get(agentType) || 0) + 1;
    this.agentCounters.set(agentType, count);

    const agentId = `${agentType}-ext-${count}`;

    // Track the external agent
    this.externalAgents.set(agentId, {
      type: agentType,
      registeredAt: Date.now(),
      socket
    });

    // Clean up when socket closes
    socket.once('close', () => {
      this.externalAgents.delete(agentId);
      this.emit('external_agent:disconnected', agentId);
    });

    this.emit('external_agent:connected', { agentId, agentType });

    return agentId;
  }

  /**
   * Get all external agents
   * @returns {Object[]}
   */
  getExternalAgents() {
    return Array.from(this.externalAgents.entries()).map(([id, info]) => ({
      id,
      type: info.type,
      registeredAt: info.registeredAt
    }));
  }

  /**
   * Send JSON-RPC result
   * @private
   */
  _sendResult(socket, id, result) {
    const response = JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
    socket.write(response);
  }

  /**
   * Send JSON-RPC error
   * @private
   */
  _sendError(socket, id, code, message) {
    const response = JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message }
    }) + '\n';
    socket.write(response);
  }

  /**
   * Find the socket for a given agent ID
   * @private
   */
  _findSocketForAgent(agentId) {
    // Check session agents (via clients map)
    for (const [socket, state] of this.clients) {
      if (state.agentId === agentId) {
        return socket;
      }
    }
    // Check external agents
    const external = this.externalAgents.get(agentId);
    if (external?.socket) {
      return external.socket;
    }
    return null;
  }

  /**
   * Send MCP notification to a socket
   * @private
   */
  _sendNotification(socket, method, params) {
    if (!socket || socket.destroyed) return;
    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params
    }) + '\n';
    try {
      socket.write(notification);
    } catch (err) {
      // Socket might be closed, ignore
    }
  }

  /**
   * Notify an agent that they have a new message
   * Uses tools/list_changed notification - clients will re-fetch tools
   * @param {string} agentId
   * @param {Object} message - The FIPA message
   */
  notifyNewMessage(agentId, message) {
    const socket = this._findSocketForAgent(agentId);
    if (socket) {
      // Send standard MCP notification that clients know how to handle
      this._sendNotification(socket, 'notifications/tools/list_changed', {});
    }
  }

  /**
   * Send a custom notification to an agent (for future async support)
   * @param {string} agentId
   * @param {string} method - Notification method name
   * @param {Object} params - Notification parameters
   */
  notifyAgent(agentId, method, params = {}) {
    const socket = this._findSocketForAgent(agentId);
    if (socket) {
      this._sendNotification(socket, method, params);
    }
    // Also emit event for local handlers
    this.emit('agent:notification', { agentId, method, params });
  }
}

module.exports = { MCPServer };
