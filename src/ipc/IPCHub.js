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
   * Route message to appropriate recipients
   */
  routeMessage(message) {
    // Handle responses to pending requests
    if (message.type === 'response' && message.replyTo) {
      const pending = this.pendingRequests.get(message.replyTo);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.resolve(message.payload);
        this.pendingRequests.delete(message.replyTo);
        return;
      }
    }

    // Route to recipients
    if (message.to === '*') {
      // Broadcast to all except sender
      for (const [id, socket] of this.agentSockets) {
        if (id !== message.from) {
          this.deliverToSocket(socket, message);
        }
      }
    } else {
      const socket = this.agentSockets.get(message.to);
      if (socket) {
        this.deliverToSocket(socket, message);
      } else {
        // Agent not connected, emit error
        this.emit('delivery:failed', {
          messageId: message.id,
          to: message.to,
          reason: 'agent_not_connected'
        });
      }
    }

    // Emit for logging/UI
    this.emit('message', message);
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
