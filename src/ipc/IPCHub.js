// src/ipc/IPCHub.js - Unix socket IPC + IAC templates

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const IAC_DEFAULT_TEMPLATE = `You are reading a message from another LLM coding agent, \${IAC_AGENT_NAME}. They want to \${IAC_AGENT_SENDER_SUMMARY}. The extended output is between <iac-agent-conversation>\${IAC_AGENT_EXTENDED}</iac-agent-conversation>`;

class IPCHub extends EventEmitter {
  constructor(session, socketDir = '/tmp/bukowski') {
    super();
    this.session = session;
    this.socketDir = socketDir;
    this.masterSocketPath = path.join(socketDir, `session-${session.id}.sock`);
    this.server = null;
    this.agentSockets = new Map();     // agentId -> socket
    this.pendingRequests = new Map();  // messageId -> { resolve, reject, timeout }
    this.messageLog = [];              // Recent messages for debugging
    this.maxLogSize = 100;
    this.template = IAC_DEFAULT_TEMPLATE;

    // Federation router. Set by attachFederation(). Has shape
    //   { resolveRemote(id), forwardIpcMessage(msg), federateSenderId(localId) }
    // When the recipient of a routeMessage call isn't local but is known
    // to the federation, the message is forwarded across instead of
    // returning delivery:failed. Local routing keeps its existing path.
    this.federation = null;
  }

  /**
   * Attach a federation router. Idempotent; pass null to detach.
   */
  attachFederation(router) {
    this.federation = router || null;
  }

  /**
   * Start the IPC server
   */
  async start() {
    await fs.promises.mkdir(this.socketDir, { recursive: true });

    // Clean up old socket
    try {
      await fs.promises.unlink(this.masterSocketPath);
    } catch {
      // Ignore if doesn't exist
    }

    this.server = net.createServer(socket => this.handleConnection(socket));

    return new Promise((resolve, reject) => {
      this.server.listen(this.masterSocketPath, () => {
        this.emit('started', this.masterSocketPath);
        resolve(this.masterSocketPath);
      });
      this.server.on('error', err => {
        this.emit('error', err);
        reject(err);
      });
    });
  }

  /**
   * Stop the IPC server
   */
  stop() {
    // Clear pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('IPC hub stopped'));
    }
    this.pendingRequests.clear();

    // Close all agent connections
    for (const socket of this.agentSockets.values()) {
      socket.destroy();
    }
    this.agentSockets.clear();

    // Close server
    if (this.server) {
      this.server.close();
      try {
        fs.unlinkSync(this.masterSocketPath);
      } catch {
        // Ignore
      }
      this.server = null;
    }

    this.emit('stopped');
  }

  /**
   * Handle new socket connection
   */
  handleConnection(socket) {
    let agentId = null;
    let buffer = '';

    socket.on('data', data => {
      buffer += data.toString();

      // Parse newline-delimited JSON messages
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);

        if (!line.trim()) continue;

        try {
          const message = JSON.parse(line);

          // First message should be registration
          if (message.type === 'register') {
            agentId = message.agentId;
            this.agentSockets.set(agentId, socket);
            this.emit('agent:connected', agentId);

            // Send acknowledgment
            socket.write(JSON.stringify({
              type: 'registered',
              agentId,
              sessionId: this.session.id,
              timestamp: Date.now()
            }) + '\n');

            continue;
          }

          // Validate message structure
          if (!this.validateMessage(message)) {
            this.emit('error', new Error(`Invalid message structure from ${agentId}`));
            continue;
          }

          // Add to log
          this.logMessage(message);

          // Route the message
          this.routeMessage(message);

        } catch (err) {
          this.emit('error', err);
        }
      }
    });

    socket.on('close', () => {
      if (agentId) {
        this.agentSockets.delete(agentId);
        this.emit('agent:disconnected', agentId);
      }
    });

    socket.on('error', err => {
      this.emit('error', err);
    });
  }

  /**
   * Validate message structure
   */
  validateMessage(message) {
    return (
      message &&
      typeof message.id === 'string' &&
      typeof message.from === 'string' &&
      typeof message.to === 'string' &&
      ['request', 'response', 'broadcast'].includes(message.type)
    );
  }

  /**
   * Route message to appropriate recipients. If the unicast target isn't
   * locally connected but federation knows of it, hand off; otherwise
   * fall through to delivery:failed.
   */
  routeMessage(message) {
    if (this._tryResolvePending(message)) return;

    if (message.to === '*') {
      for (const [id, socket] of this.agentSockets) {
        if (id !== message.from) this.deliverToSocket(socket, message);
      }
    } else {
      const socket = this.agentSockets.get(message.to);
      if (socket) {
        this.deliverToSocket(socket, message);
      } else if (this.federation && this.federation.resolveRemote(message.to)) {
        // Non-local target known to a federated peer. Stamp sender into
        // its federated form (so the peer can address replies back), then
        // hand off — FederationHub rewrites `to` to the peer's local id.
        //
        // We rewrite the IPC-level `from` AND, when this is a FIPA
        // envelope, the embedded FIPAMessage's `sender.name`. The receiving
        // bukowski reconstructs the FIPAMessage from payload._fipaMessage,
        // so without this rewrite peers see the original local id (e.g.
        // "claude-1" on both sides) — replies then go to the wrong agent
        // ("loopback") and chat attribution is wrong.
        const federatedFrom = this.federation.federateSenderId
          ? this.federation.federateSenderId(message.from)
          : message.from;
        let forwarded;
        const innerSender = message.payload?._fipaMessage?.sender;
        if (innerSender && innerSender.name !== federatedFrom) {
          forwarded = {
            ...message,
            from: federatedFrom,
            payload: {
              ...message.payload,
              _fipaMessage: {
                ...message.payload._fipaMessage,
                sender: { ...innerSender, name: federatedFrom }
              }
            }
          };
        } else {
          forwarded = { ...message, from: federatedFrom };
        }
        const ok = this.federation.forwardIpcMessage(forwarded);
        if (!ok) {
          this.emit('delivery:failed', {
            messageId: message.id,
            to: message.to,
            reason: 'federation_forward_failed'
          });
        }
      } else {
        this.emit('delivery:failed', {
          messageId: message.id,
          to: message.to,
          reason: 'agent_not_connected'
        });
      }
    }

    this.emit('message', message);
  }

  /**
   * Inject a message arriving from a federated peer. Local-only delivery —
   * never re-forwards, even if the target isn't here (the peer routed to us
   * thinking we have the target; if we don't, that's a delivery failure,
   * not a reason to bounce the message around).
   */
  injectFederatedMessage(message) {
    if (this._tryResolvePending(message)) return;

    if (message.to === '*') {
      for (const [id, socket] of this.agentSockets) {
        if (id !== message.from) this.deliverToSocket(socket, message);
      }
    } else {
      const socket = this.agentSockets.get(message.to);
      if (socket) {
        this.deliverToSocket(socket, message);
      } else {
        this.emit('delivery:failed', {
          messageId: message.id,
          to: message.to,
          reason: 'federated_target_not_local'
        });
      }
    }

    this.emit('message', message);
  }

  /**
   * Resolve a pending outbound request waiting on this response. Shared
   * by both routing entrypoints. Returns true if the message was consumed.
   * @private
   */
  _tryResolvePending(message) {
    if (message.type !== 'response' || !message.replyTo) return false;
    const pending = this.pendingRequests.get(message.replyTo);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    pending.resolve(message.payload);
    this.pendingRequests.delete(message.replyTo);
    return true;
  }

  /**
   * Deliver message to socket
   */
  deliverToSocket(socket, message) {
    try {
      socket.write(JSON.stringify(message) + '\n');
    } catch (err) {
      this.emit('error', err);
    }
  }

  /**
   * Create IAC envelope from template
   */
  formatIACEnvelope(senderName, summary, content) {
    return this.template
      .replace(/\$\{IAC_AGENT_NAME\}/g, senderName)
      .replace(/\$\{IAC_AGENT_SENDER_SUMMARY\}/g, summary)
      .replace(/\$\{IAC_AGENT_EXTENDED\}/g, content);
  }

  /**
   * Send request to specific agent and wait for response
   */
  async sendRequest(from, to, method, payload, timeout = 30000) {
    const message = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      from,
      to,
      type: 'request',
      method,
      payload
    };

    // Log the message
    this.logMessage(message);

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(message.id);
        reject(new Error(`IPC request timeout: ${method} to ${to}`));
      }, timeout);

      this.pendingRequests.set(message.id, {
        resolve,
        reject,
        timeout: timeoutHandle
      });

      // Route the message
      this.routeMessage(message);
    });
  }

  /**
   * Send response to a request
   */
  sendResponse(originalMessage, payload) {
    const response = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      from: originalMessage.to,
      to: originalMessage.from,
      type: 'response',
      method: originalMessage.method,
      payload,
      replyTo: originalMessage.id
    };

    this.logMessage(response);
    this.routeMessage(response);
  }

  /**
   * Broadcast message to all agents
   */
  broadcast(from, method, payload, summary = '') {
    const senderAgent = this.session.getAgent(from);
    const senderName = senderAgent?.name || from;

    const message = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      from,
      to: '*',
      type: 'broadcast',
      method,
      payload: {
        ...payload,
        _iacEnvelope: this.formatIACEnvelope(
          senderName,
          summary,
          JSON.stringify(payload, null, 2)
        )
      }
    };

    this.logMessage(message);
    this.routeMessage(message);
  }

  /**
   * Send message to specific agent (fire-and-forget)
   */
  send(from, to, method, payload, summary = '') {
    const senderAgent = this.session.getAgent(from);
    const senderName = senderAgent?.name || from;

    const message = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      from,
      to,
      type: 'request',
      method,
      payload: {
        ...payload,
        _iacEnvelope: this.formatIACEnvelope(
          senderName,
          summary,
          JSON.stringify(payload, null, 2)
        )
      }
    };

    this.logMessage(message);
    this.routeMessage(message);
  }

  /**
   * Log message
   */
  logMessage(message) {
    this.messageLog.push({
      ...message,
      _logged: Date.now()
    });

    // Trim log
    while (this.messageLog.length > this.maxLogSize) {
      this.messageLog.shift();
    }
  }

  /**
   * Get message log
   */
  getLog(count = 20) {
    return this.messageLog.slice(-count);
  }

  /**
   * Clear message log
   */
  clearLog() {
    this.messageLog = [];
  }

  /**
   * Set IAC template
   */
  setTemplate(template) {
    this.template = template;
  }

  /**
   * Get IAC template
   */
  getTemplate() {
    return this.template;
  }

  /**
   * Get connected agents
   */
  getConnectedAgents() {
    return Array.from(this.agentSockets.keys());
  }

  /**
   * Check if agent is connected to IPC
   */
  isAgentConnected(agentId) {
    return this.agentSockets.has(agentId);
  }

  /**
   * Get socket path for external agents to connect
   */
  getSocketPath() {
    return this.masterSocketPath;
  }
}

module.exports = { IPCHub, IAC_DEFAULT_TEMPLATE };
