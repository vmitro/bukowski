// src/mcp/MCPServer.js - MCP Server for FIPA ACL Agent Communication
// Exposes tools for agents to send/receive structured messages

const EventEmitter = require('events');
const net = require('net');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { hostFromCwd } = require('../utils/host');

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
  constructor(session, fipaHub, ipcHub, dashboardStore = null) {
    super();

    this.session = session;
    this.fipaHub = fipaHub;
    this.ipcHub = ipcHub;
    // Canonical project-dashboard store (shared ~/.bukowski/dashboard on the
    // box). Present on every instance; reads/writes go straight to the shared
    // files, which the store re-reads per op so federated instances on one box
    // stay consistent. null only if the host opted out.
    this.dashboardStore = dashboardStore;

    this.server = null;
    this.socketPath = null;
    this.clients = new Map();  // socket -> { agentId, buffer }

    // agentId -> socket for connections that declared role:'channel' at
    // initialize (the channel-only plugin server). notifyNewMessage prefers
    // these so the channel push reaches the connection Claude Code actually
    // loaded as a channel, not the bare tools connection of the same agent.
    this.channelSockets = new Map();

    // Agents currently mid-turn (between a UserPromptSubmit and the Stop that
    // ends the turn), reported by the lifecycle hooks via bukowski/turn_state.
    // While an agent is busy its assistant message is open and carries
    // `thinking` blocks that must be re-sent verbatim on every continuation;
    // an out-of-turn <channel> injection there makes Claude Code re-emit that
    // message with an altered thinking block and the API rejects the next
    // request (400 "thinking ... blocks in the latest assistant message cannot
    // be modified"). So notifyNewMessage suppresses the channel PUSH for busy
    // agents and lets the boundary hooks (Stop) deliver instead.
    this.busyAgents = new Set();

    // Define available tools
    this.tools = this._defineTools();

    // Message queues per agent (for polling)
    this.messageQueues = new Map();  // agentId -> [{...message}]

    // External agents registered via bridge
    // Map: agentId -> { type, registeredAt, socket }
    this.externalAgents = new Map();

    // Counter for generating unique agent IDs
    this.agentCounters = new Map();  // type -> count

    // Federation hub, attached by the host process once it's running.
    // Used so `list_agents` can also surface remote agents reachable
    // through other bukowski instances.
    this.federationHub = null;
  }

  /**
   * Attach the federation hub so list_agents includes remote peers.
   * Idempotent; pass null to detach.
   */
  attachFederation(hub) {
    this.federationHub = hub || null;
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
            to: { type: 'string', description: 'Target agent ID. Session agents: "claude-1", "codex-1". External clients use their cwd basename: a claude REPL in ~/azra is "claude-azra-1". Use list_agents to discover.' },
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
      },
      ...require('./dashboardTools').DASHBOARD_TOOLS
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
          // External agent via bridge - assign a unique ID. Host segment comes
          // from the bridge's cwd basename so a claude REPL in ~/azra shows up
          // as claude-azra-1; legacy bridges with no cwd land as claude-ext-1.
          assignedId = this._assignAgentId(params.agentType, socket, params.cwd);
        }

        clientState.agentId = assignedId;

        // A role:'channel' connection (the channel-only plugin server) is where
        // channel pushes for this agent must go. Track it separately and clean
        // up on close so a reconnect re-registers fresh.
        if (params?.role === 'channel' && assignedId) {
          this.channelSockets.set(assignedId, socket);
          socket.once('close', () => {
            if (this.channelSockets.get(assignedId) === socket) {
              this.channelSockets.delete(assignedId);
            }
          });
        }

        this._sendResult(socket, id, {
          protocolVersion: '2024-11-05',
          // experimental['claude/channel'] advertises Claude Code "channels":
          // it lets us push notifications/claude/channel events that the client
          // injects out-of-turn (a <channel> block), waking the agent without a
          // PTY keystroke. A direct socket client sees this; the bridge declares
          // it again on its own initialize since that is what Claude Code reads.
          capabilities: {
            tools: { listChanged: true },
            experimental: { 'claude/channel': {} }
          },
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

      case 'bukowski/turn_state': {
        // Lifecycle signal from the hooks: UserPromptSubmit reports 'busy' (a
        // turn just opened), Stop reports 'idle' (the turn closed). We use this
        // ONLY to decide whether it is safe to push an out-of-turn <channel>
        // block (see notifyNewMessage / busyAgents). Not an MCP tool.
        const tId = params?.agentId || clientState.agentId;
        if (tId) {
          if (params?.state === 'busy') this.busyAgents.add(tId);
          else this.busyAgents.delete(tId);
        }
        this._sendResult(socket, id, { ok: true, busy: tId ? this.busyAgents.has(tId) : false });
        break;
      }

      case 'bukowski/peek_messages': {
        // Non-consuming peek used by sideband channels (e.g. the Claude Code
        // UserPromptSubmit hook). Caller may pass an explicit agentId; we
        // fall back to the client's own identity. Not exposed as an MCP tool.
        const targetId = params?.agentId || clientState.agentId;
        const queue = (targetId && this.messageQueues.get(targetId)) || [];
        // Skip entries already injected via the channel push (the agent saw them
        // inline as a <channel> block) so the hooks don't re-surface and
        // double-deliver. This relies on the channel being reliable — it is on
        // the dangerous-flag path (one connection that actually injects). If a
        // push didn't land (dead connection) the entry stays unmarked and the
        // hook still delivers it; get_pending_messages always returns everything.
        const visible = queue.filter((m) => !m._channelDelivered);
        const limit = Math.max(1, Math.min(20, params?.limit || 5));
        const previews = visible.slice(0, limit).map((m) => {
          let excerpt = '';
          if (typeof m.content === 'string') {
            excerpt = m.content.length > 160 ? m.content.slice(0, 160) + '…' : m.content;
          } else if (m.content != null) {
            try { excerpt = JSON.stringify(m.content).slice(0, 160); } catch { excerpt = ''; }
          }
          return {
            sender: m.sender?.name || null,
            performative: m.performative || null,
            excerpt
          };
        });
        this._sendResult(socket, id, { count: visible.length, previews });
        break;
      }

      case 'bukowski/peek_unannounced_messages':
      case 'bukowski/peek_unannounced_requests': {
        // Atomic read+mark formerly used by the Claude Code PostToolUse hook to
        // deliver mid-turn interrupts. That hook is no longer registered — it
        // modified the open assistant turn's thinking blocks and tripped API 400
        // "`thinking` blocks ... cannot be modified" under interleaved thinking
        // (see mcp/hooks/posttool-use.js). Delivery is now Stop/UserPromptSubmit
        // only, both via peek_messages at turn boundaries. This method (and its
        // legacy `_requests` alias) is retained as a harmless no-op endpoint so a
        // stale hook binary still running with the old --settings doesn't error;
        // the `_midTurnAnnounced` dedupe flag is no longer consulted elsewhere.
        const targetId = params?.agentId || clientState.agentId;
        const queue = (targetId && this.messageQueues.get(targetId)) || [];
        const limit = Math.max(1, Math.min(10, params?.limit || 5));
        const matches = [];
        for (const m of queue) {
          if (m._midTurnAnnounced) continue;
          m._midTurnAnnounced = true;
          let excerpt = '';
          if (typeof m.content === 'string') {
            excerpt = m.content.length > 200 ? m.content.slice(0, 200) + '…' : m.content;
          } else if (m.content != null) {
            try { excerpt = JSON.stringify(m.content).slice(0, 200); } catch { excerpt = ''; }
          }
          matches.push({
            sender: m.sender?.name || null,
            performative: m.performative || 'inform',
            excerpt
          });
          if (matches.length >= limit) break;
        }
        this._sendResult(socket, id, { count: matches.length, previews: matches });
        break;
      }

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
    // Ensure required content-bearing args are non-empty strings. Some MCP clients
    // skip schema validation, and a missing arg used to crash the host process when
    // it reached formatFIPAForPTY in multi.js.
    const requireString = (field) => {
      const v = args?.[field];
      if (typeof v !== 'string' || v.length === 0) {
        throw new Error(`${toolName} requires a non-empty string "${field}" argument`);
      }
    };

    switch (toolName) {
      case 'fipa_request':
        requireString('to'); requireString('action');
        return this._sendFipaMessage('request', callerAgentId, args.to, args.action, args.conversationId);

      case 'fipa_inform':
        requireString('to'); requireString('content');
        return this._sendFipaMessage('inform', callerAgentId, args.to, args.content, args.conversationId);

      case 'fipa_query_if':
        requireString('to'); requireString('proposition');
        return this._sendFipaMessage('query-if', callerAgentId, args.to, args.proposition, args.conversationId);

      case 'fipa_query_ref':
        requireString('to'); requireString('reference');
        return this._sendFipaMessage('query-ref', callerAgentId, args.to, args.reference, args.conversationId);

      case 'fipa_cfp': {
        requireString('task');
        const localRecipients = this.session.getAllAgents()
          .filter(a => a.id !== callerAgentId && a.type !== 'chat')
          .map(a => a.id);
        const externalRecipients = Array.from(this.externalAgents.keys())
          .filter(id => id !== callerAgentId);
        const federatedRecipients = this.federationHub?.remoteAgents
          ? Array.from(this.federationHub.remoteAgents.keys())
          : [];
        const recipients = [...localRecipients, ...externalRecipients, ...federatedRecipients];
        return this.fipaHub.cfp(callerAgentId, recipients, {
          task: args.task,
          deadline: args.deadline
        });
      }

      case 'fipa_propose':
        requireString('to'); requireString('proposal');
        return this._sendFipaMessage('propose', callerAgentId, args.to, args.proposal, args.conversationId);

      case 'fipa_agree':
        requireString('to');
        return this._sendFipaMessage('agree', callerAgentId, args.to, null, args.conversationId);

      case 'fipa_refuse':
        requireString('to'); requireString('reason');
        return this._sendFipaMessage('refuse', callerAgentId, args.to, args.reason, args.conversationId);

      case 'list_agents': {
        // Local session agents.
        const sessionAgents = this.session.getAllAgents().map(a => ({
          id: a.id,
          name: a.name,
          type: a.type,
          source: 'session'
        }));

        // External bridge clients (claude/codex/gemini REPLs connected
        // from outside any bukowski's session).
        const externalAgents = this.getExternalAgents().map(a => ({
          id: a.id,
          name: a.id,
          type: a.type,
          host: a.host,
          source: 'external'
        }));

        // Agents living in other bukowski instances, reachable via
        // federation. The `id` here is the federated form (claude-vladimir-1)
        // — that's what callers pass to fipa_* tools.
        const federatedAgents = [];
        if (this.federationHub?.remoteAgents) {
          for (const [federatedId, info] of this.federationHub.remoteAgents) {
            federatedAgents.push({
              id: federatedId,
              name: federatedId,
              type: info.type,
              host: info.peerHost,
              source: 'federated'
            });
          }
        }

        return [...sessionAgents, ...externalAgents, ...federatedAgents];
      }

      case 'get_pending_messages': {
        const limit = args.limit || 10;
        const queue = this.messageQueues.get(callerAgentId) || [];
        const messages = queue.splice(0, limit);
        return { messages, remaining: queue.length };
      }

      case 'get_conversations': {
        // ConversationManager is not itself iterable; its Map of
        // conversations lives at .conversations. Each value is a
        // Conversation object whose canonical shape comes from
        // getSummary(): {id, initiator, protocol, state, messageCount,
        // duration, isComplete, participants}.
        const status = args.status || 'all';
        const convMap = this.fipaHub?.conversations?.conversations;
        if (!convMap) return [];

        const out = [];
        for (const conv of convMap.values()) {
          let summary;
          try { summary = conv.getSummary(); }
          catch { continue; }

          if (!summary.participants.includes(callerAgentId)) continue;

          // Map status filter to summary fields. ConversationManager
          // exposes `state` from the protocol and `isComplete` directly.
          if (status === 'completed' && !summary.isComplete) continue;
          if (status === 'active' && summary.isComplete) continue;

          out.push(summary);
        }
        return out;
      }

      case 'register_agent': {
        // Called by bridge to explicitly register
        // Usually handled in initialize, but can be called manually
        const agentType = args.type || 'unknown';
        // Find the socket for this caller (best effort)
        const agentId = callerAgentId || `${agentType}-ext-${Date.now()}`;
        return { agentId, registered: true };
      }

      // ── project dashboard ────────────────────────────────────────────────
      // The store enforces all governance (curator-only, owner-scoped, ref
      // requirements) keyed on callerAgentId; it throws DASHBOARD_ERROR-tagged
      // errors which the tools/call catch surfaces as an isError text block.
      // Mutations fire a best-effort live signal to project participants.
      case 'dashboard_list_projects':
        return this._dash().listProjects();

      case 'dashboard_delete_project': {
        requireString('projectId');
        const r = this._dash().deleteProject(callerAgentId, args, { ts: Date.now() });
        return r;
      }

      case 'dashboard_query':
        requireString('projectId');
        return this._dash().queryEntries(callerAgentId, args);

      case 'dashboard_digest':
        requireString('projectId');
        return this._dash().digest(callerAgentId, args);

      case 'dashboard_chain':
        requireString('fromRef');
        return this._dash().walkChain(args.fromRef);

      case 'dashboard_create_project': {
        requireString('name'); requireString('goal');
        const r = this._dash().createProject(callerAgentId, args, { ts: Date.now() });
        this._signalDashboardChange(r.projectId, { op: 'create-project', rev: r.rev, by: callerAgentId });
        return r;
      }
      case 'dashboard_set_goal': {
        requireString('projectId'); requireString('goal');
        const r = this._dash().setGoal(callerAgentId, args, { ts: Date.now() });
        this._signalDashboardChange(r.projectId, { op: 'set-goal', rev: r.rev, by: callerAgentId });
        return r;
      }
      case 'dashboard_map_repos': {
        requireString('projectId');
        const r = this._dash().mapRepos(callerAgentId, args, { ts: Date.now() });
        this._signalDashboardChange(r.projectId, { op: 'map-repos', rev: r.rev, by: callerAgentId });
        return r;
      }
      case 'dashboard_set_roadmap': {
        requireString('projectId');
        const r = this._dash().setRoadmap(callerAgentId, args, { ts: Date.now() });
        this._signalDashboardChange(r.projectId, { op: 'set-roadmap', rev: r.rev, by: callerAgentId });
        return r;
      }
      case 'dashboard_transfer_curator': {
        requireString('projectId'); requireString('to');
        const r = this._dash().transferCurator(callerAgentId, args, { ts: Date.now() });
        this._signalDashboardChange(r.projectId, { op: 'transfer-curator', rev: r.rev, by: callerAgentId });
        return r;
      }
      case 'dashboard_open_election': {
        requireString('projectId');
        const m = this._dash().meta(args.projectId);
        const curatorOnline = this._isAgentReachable(m.curator);
        const onlineParticipants = m.participants.filter((a) => this._isAgentReachable(a));
        const r = this._dash().openElection(callerAgentId, args, { ts: Date.now() }, { curatorOnline, onlineParticipants });
        this._signalDashboardChange(r.projectId, { op: 'open-election', rev: r.rev, by: callerAgentId });
        return r;
      }
      case 'dashboard_vote': {
        requireString('projectId'); requireString('candidate');
        const r = this._dash().vote(callerAgentId, args, { ts: Date.now() });
        this._signalDashboardChange(r.projectId, { op: r.tallied ? 'elect-curator' : 'vote', entryId: r.curator, rev: r.rev, by: callerAgentId });
        return r;
      }
      case 'dashboard_close_election': {
        requireString('projectId');
        const r = this._dash().closeElection(callerAgentId, args, { ts: Date.now() });
        this._signalDashboardChange(r.projectId, { op: 'elect-curator', entryId: r.curator, rev: r.rev, by: callerAgentId });
        return r;
      }
      case 'dashboard_set_entry': {
        requireString('projectId'); requireString('repo'); requireString('oneliner');
        const r = this._dash().setEntry(callerAgentId, args, { ts: Date.now(), conv: args.conversationId || null });
        const gitWarn = this._validateShaRefs(r.projectId, args.refs); // soft, best-effort
        if (gitWarn.length) r.warnings = [...(r.warnings || []), ...gitWarn];
        this._signalDashboardChange(r.projectId, { op: r.op, entryId: r.entryId, rev: r.rev, ref: { refs: args.refs || [] }, by: callerAgentId });
        return r;
      }
      case 'dashboard_close_entry': {
        requireString('projectId'); requireString('entryId');
        const r = this._dash().closeEntry(callerAgentId, args, { ts: Date.now() });
        this._signalDashboardChange(r.projectId, { op: 'close', entryId: r.entryId, rev: r.rev, by: callerAgentId });
        return r;
      }
      case 'dashboard_comment_entry': {
        requireString('projectId'); requireString('entryId'); requireString('text');
        const r = this._dash().commentEntry(callerAgentId, args, { ts: Date.now() });
        this._signalDashboardChange(r.projectId, { op: 'comment', entryId: r.entryId, rev: r.rev, by: callerAgentId });
        return r;
      }
      case 'dashboard_promote': {
        requireString('projectId'); requireString('entryId'); requireString('toCategory');
        const r = this._dash().promoteEntry(callerAgentId, args, { ts: Date.now() });
        this._signalDashboardChange(r.projectId, { op: 'promote', entryId: r.entryId, rev: r.rev, by: callerAgentId });
        return r;
      }
      case 'dashboard_link': {
        requireString('projectId'); requireString('entryId');
        const r = this._dash().linkBlockedOn(callerAgentId, args, { ts: Date.now() });
        this._signalDashboardChange(r.projectId, { op: 'link', entryId: r.entryId, rev: r.rev, by: callerAgentId });
        return r;
      }

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  /**
   * Best-effort liveness: is an agent currently reachable from this instance
   * (local session, external bridge, or federated peer)? Used to decide whether
   * a project curator is offline before allowing an election. A federated id
   * for THIS instance's own session agent (claude-<thisHost>-N) maps back to the
   * local session agent.
   * @private
   */
  _isAgentReachable(agentId) {
    if (!agentId || agentId === 'user') return false;
    if (this.session.getAgent?.(agentId)) return true;
    if (this.externalAgents.has(agentId)) return true;
    if (this.federationHub?.remoteAgents?.has(agentId)) return true;
    const host = process.env.BUKOWSKI_HOST;
    const m = host && new RegExp(`^(claude|codex|gemini)-${host}-(\\d+)$`).exec(agentId);
    if (m && this.session.getAgent?.(`${m[1]}-${m[2]}`)) return true;
    return false;
  }

  /**
   * Best-effort, SOFT validation that each "<repo>://sha/<sha>" ref resolves to a
   * real object in that repo's checkout — catches wrong-repo/dangling shas before
   * they rot chain-walks. Never blocks: if the checkout is absent or git fails,
   * the ref is left unverified. Returns a list of warning strings.
   * @private
   */
  _validateShaRefs(projectId, refs) {
    const warns = [];
    if (!Array.isArray(refs) || !refs.length || !this.dashboardStore) return warns;
    let roots;
    try { roots = new Map(this.dashboardStore.repoRoots(projectId).map((r) => [r.repo, r.root])); }
    catch { return warns; }
    const { execFileSync } = require('child_process');
    for (const ref of refs) {
      const m = /^([A-Za-z][\w-]*):\/\/sha\/([0-9a-fA-F]{4,40})$/.exec(String(ref));
      if (!m) continue;
      const root = roots.get(m[1]);
      if (!root || !fs.existsSync(root)) continue; // can't verify → leave it (soft)
      try { execFileSync('git', ['-C', root, 'rev-parse', '--git-dir'], { stdio: 'ignore', timeout: 3000 }); }
      catch { continue; } // not a git checkout → can't verify (soft-skip, no false warning)
      try {
        execFileSync('git', ['-C', root, 'cat-file', '-e', m[2]], { stdio: 'ignore', timeout: 3000 });
      } catch {
        warns.push(`ref "${ref}": sha not found in ${m[1]} checkout (${root}) — possible wrong-repo sha`);
      }
    }
    return warns;
  }

  /**
   * Return the dashboard store or throw a tagged error if this instance has none.
   * @private
   */
  _dash() {
    if (!this.dashboardStore) {
      throw new Error('DASHBOARD_ERROR ' + JSON.stringify({ code: 'NO_STORE', message: 'dashboard not available on this bukowski instance' }));
    }
    return this.dashboardStore;
  }

  /**
   * Best-effort live signal: tell a project's participants the dashboard changed
   * so they re-pull (out-of-turn <channel> block via the normal inform path).
   * Carries a pointer + nudge, never content. Never throws — a signal failure
   * must not fail the mutation that already persisted.
   * @private
   */
  _signalDashboardChange(projectId, info) {
    try {
      if (!this.dashboardStore || !this.fipaHub) return;
      const p = this.dashboardStore.projects.get(projectId);
      if (!p) return;
      // Relevance-scoped: entry edits reach only stakeholders (owner + cross-
      // linked), project-level events reach all participants. Kills the noise
      // of an agent iterating its own unlinked entry.
      const recipients = this.dashboardStore.recipientsFor(projectId, info);
      if (!recipients.length) return;
      // A human-readable change-feed line, delivered over the SAME bus as FIPA
      // messages: an inform → out-of-turn <channel> block for each participant
      // (Stop-hook safety net underneath). e.g. "[dashboard:meddaemon-azra]
      // claude-meddaemon-1 closed bug-1 (rev 7)".
      const VERBS = {
        create: 'added', update: 'updated', close: 'closed', comment: 'commented on',
        promote: 'promoted', link: 'linked', 'create-project': 'created project',
        'set-goal': 'set the goal of', 'map-repos': 'remapped',
        'set-roadmap': 'updated the roadmap of', 'transfer-curator': 'transferred the lead of',
        'open-election': 'opened a curator election for', vote: 'voted in the election for',
        'elect-curator': 'elected the new curator of',
      };
      const verb = VERBS[info.op] || info.op;
      const target = info.entryId || projectId;
      const since = Math.max(0, (info.rev || 1) - 1);
      // Attribute to the FEDERATED id (claude-<host>-N), not the local session
      // id (claude-1) — every agent is "claude-1" locally, so the raw caller is
      // ambiguous in a cross-agent feed.
      const by = (this.dashboardStore.federate ? this.dashboardStore.federate(info.by) : info.by) || info.by;
      const summary = `[dashboard:${projectId}] ${by} ${verb} ${target} (rev ${info.rev}) — `
        + `dashboard_digest{projectId:"${projectId}",sinceRev:${since}} for details`;
      this.fipaHub.inform(info.by || p.curator, recipients, summary, { ontology: 'bukowski-dashboard' });
    } catch { /* signal is advisory; delivery is guaranteed by the next pull */ }
  }

  /**
   * Send a FIPA message via FIPAHub
   * @private
   */
  _sendFipaMessage(performative, from, to, content, conversationId = null) {
    if (!this.fipaHub) {
      throw new Error('FIPA Hub not available');
    }

    // The target may be addressed by the host-named federated alias of an
    // agent living on THIS instance (claude-<host>-N) — that's the id the
    // federation advertises, so agents copy it even for same-instance
    // peers. Canonicalize to the local id so delivery goes straight to the
    // local queue instead of failing "Unknown agent". Checked before
    // resolveRemote so an alias of our own agent can never be routed out.
    const localAlias = this.federationHub?.resolveLocalAlias?.(to) || null;
    if (localAlias) to = localAlias;

    // Validate target agent exists (session, external, federated, or
    // the special "user" identity).
    const sessionAgent = this.session.getAgent(to);
    const externalAgent = this.externalAgents.get(to);
    const federatedAgent = this.federationHub?.resolveRemote?.(to) || null;
    const isUser = to === 'user';
    if (!sessionAgent && !externalAgent && !federatedAgent && !isUser) {
      throw new Error(`Unknown agent: ${to}`);
    }

    // Send via FIPAHub. The hub methods are async (request/query even wait
    // for the reply); we deliberately don't await — MCP callers poll for
    // responses via get_pending_messages. But that means the returned
    // promise can't supply the conversationId, so mint one up front and
    // thread it through: the caller needs it to correlate the reply.
    if (!conversationId) conversationId = crypto.randomUUID();
    const opts = { conversationId };
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
        result = this.fipaHub.inform(from, to, { [performative]: content }, opts);
    }
    void result; // fire-and-forget; replies arrive via the message queue

    return { success: true, conversationId };
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
   * @param {string} [cwd] - Bridge's cwd; basename becomes the host segment
   * @returns {string} Assigned agent ID
   */
  _assignAgentId(agentType, socket, cwd) {
    const host = hostFromCwd(cwd);

    // Counter is per <type, host> so each origin directory has its own n.
    const counterKey = `${agentType}-${host}`;
    const count = (this.agentCounters.get(counterKey) || 0) + 1;
    this.agentCounters.set(counterKey, count);

    const agentId = `${agentType}-${host}-${count}`;

    // Track the external agent
    this.externalAgents.set(agentId, {
      type: agentType,
      host,
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
      host: info.host,
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
    if (!socket || socket.destroyed) return false;
    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params
    }) + '\n';
    try {
      socket.write(notification);
      return true;
    } catch (err) {
      // Socket might be closed, ignore
      return false;
    }
  }

  /**
   * Notify an agent that they have a new message.
   *
   * Pushes a Claude Code "channel" event (notifications/claude/channel). When
   * the client negotiated the capability and was launched with the channel
   * enabled, it injects the content as an out-of-turn <channel> block, waking
   * the agent immediately without a PTY keystroke. If the client doesn't
   * understand the notification (older build, unsupported backend, or channels
   * not enabled), it's silently dropped — the message is still queued for
   * get_pending_messages and the Stop hook still peeks it at turn end, so
   * delivery degrades gracefully rather than failing.
   *
   * The previous tools/list_changed notification is gone: it never reached the
   * client (the stdio bridge dropped server-initiated notifications) and
   * re-fetching the tool list on every message was the wrong signal anyway.
   *
   * @param {string} agentId
   * @param {Object} message - The FIPA message
   */
  notifyNewMessage(agentId, message) {
    // Channels are a Claude Code feature; codex/gemini clients don't implement
    // notifications/claude/channel and just ignore it. Only push to claude.
    if (!this._isClaudeAgent(agentId)) return;
    // SAFETY: never inject an out-of-turn <channel> block while the agent is
    // mid-turn. Its open assistant message carries `thinking` blocks that must
    // be re-sent verbatim; a channel injection there corrupts them and the API
    // rejects the next request (400 thinking-blocks-cannot-be-modified). The
    // message stays queued (NOT marked _channelDelivered), so the Stop hook
    // delivers it at the safe turn boundary. Idle agents get the immediate push.
    if (this.busyAgents.has(agentId)) return;
    // Broadcast the channel event to EVERY connection this agent holds: the
    // channel connection (plugin server, role=channel) injects it as a <channel>
    // block; a tools-only connection ignores the unknown notification. We don't
    // try to pick "the" right socket because the dual-connection plugin setup
    // makes that brittle — a wrong guess silently drops the push. Broadcasting
    // is harmless and robust.
    //
    // This push is PURELY ADDITIVE. Delivery is guaranteed by the queue + the
    // Stop/UserPromptSubmit hooks; a channel push is fire-and-forget with no ack,
    // so we never mark anything "delivered" here. If the channel injects too, the
    // consumer can dedup against the inbox via the channel's inbox_id meta.
    const sockets = new Set();
    const chan = this.channelSockets.get(agentId);
    if (chan) sockets.add(chan);
    for (const [sock, st] of this.clients) {
      if (st.agentId === agentId) sockets.add(sock);
    }
    if (sockets.size === 0) return;
    const { content, meta } = this._buildChannelEvent(agentId, message);
    let sent = false;
    for (const sock of sockets) {
      if (this._sendNotification(sock, 'notifications/claude/channel', { content, meta })) sent = true;
    }
    // Mark delivered so the Stop/UserPromptSubmit hooks don't re-surface (and
    // double-deliver) what the channel already injected as a <channel> block.
    // Only when a write actually landed: a dead connection means the channel
    // didn't carry it, so the hook safety net must still fire. The bare
    // (dangerous-flag) channel is a single reliable connection, so this holds;
    // get_pending_messages still returns everything on an explicit pull.
    if (sent) message._channelDelivered = true;
  }

  /**
   * Whether an agent id refers to a claude agent (session or external bridge).
   * Used to limit channel pushes to clients that actually support them.
   * @private
   */
  _isClaudeAgent(agentId) {
    const sessionAgent = this.session.getAgent?.(agentId);
    if (sessionAgent) return sessionAgent.type === 'claude';
    const external = this.externalAgents.get(agentId);
    if (external) return external.type === 'claude';
    return false;
  }

  /**
   * Build the {content, meta} for a channel event from a FIPA message.
   * meta keys must be identifiers (letters/digits/underscore) and values must
   * be strings — the client turns them into <channel> tag attributes and
   * silently drops anything else. The `source` attribute is added by the
   * client from our server name ("bukowski"), so we don't set it here.
   * @private
   */
  _buildChannelEvent(agentId, message) {
    const sender = message?.sender?.name || 'unknown';
    const perf = message?.performative || 'inform';
    const convId = message?.conversationId;

    let body;
    if (typeof message?.content === 'string') {
      body = message.content;
    } else if (message?.content == null) {
      body = '';
    } else {
      body = JSON.stringify(message.content, null, 2);
    }

    // Keep short messages inline; for long ones, point at get_pending_messages
    // rather than dumping a wall of text into the agent's context.
    const MAX_INLINE = 1000;
    const truncated = body.length > MAX_INLINE;
    const shown = truncated ? `${body.slice(0, MAX_INLINE)}…` : body;

    const lines = [`FIPA ${perf} from ${sender}:`];
    if (shown) lines.push('', shown);
    if (truncated) lines.push('', '(truncated — call get_pending_messages for the full text)');
    lines.push('', 'Reply with the fipa_* tools.');

    const meta = { sender, performative: perf };
    // The inbox id keys this push to its queue entry, so a consumer can dedup
    // the channel block against a later get_pending_messages pull (same _id).
    if (message?._id) meta.inbox_id = String(message._id);
    if (convId) meta.conversation_id = String(convId);
    const queue = this.messageQueues.get(agentId);
    if (queue) meta.queue_size = String(queue.length);

    return { content: lines.join('\n'), meta };
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
