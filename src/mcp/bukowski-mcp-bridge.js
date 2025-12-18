#!/usr/bin/env node
// src/mcp/bukowski-mcp-bridge.js - Stdio-to-socket MCP bridge
// Translates MCP stdio transport to bukowski's Unix socket MCP server

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

/**
 * Get ancestor PIDs (for matching to session agent PTY PID)
 * Walks up the process tree up to 10 levels
 */
function getAncestorPids() {
  const ancestors = [];
  let pid = process.ppid;

  for (let i = 0; i < 10 && pid > 1; i++) {
    ancestors.push(pid);
    try {
      // Read parent PID from /proc/[pid]/stat
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      // Field 4 is ppid (format: "pid (comm) state ppid ...")
      const match = stat.match(/^\d+\s+\([^)]+\)\s+\S+\s+(\d+)/);
      if (match) {
        pid = parseInt(match[1], 10);
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  return ancestors;
}

// Discovery file location
const SOCKET_FILE = path.join(os.homedir(), '.bukowski-mcp-socket');

// Agent ID assigned by bukowski
let agentId = null;
let agentType = null;

// Socket connection
let socket = null;
let socketBuffer = '';
let connected = false;
let connecting = false;

// Pending requests waiting for responses
const pendingRequests = new Map();

/**
 * Discover bukowski's MCP socket
 * Priority: env var > discovery file (skip stale socket search)
 */
function discoverSocket() {
  // 1. Check environment variable (most reliable)
  if (process.env.BUKOWSKI_MCP_SOCKET) {
    const envPath = process.env.BUKOWSKI_MCP_SOCKET;
    if (fs.existsSync(envPath)) {
      return envPath;
    }
  }

  // 2. Check discovery file (written by active bukowski instance)
  try {
    const socketPath = fs.readFileSync(SOCKET_FILE, 'utf-8').trim();
    if (fs.existsSync(socketPath)) {
      return socketPath;
    }
  } catch {
    // File doesn't exist or can't be read
  }

  // Don't search /tmp for stale sockets - they cause hangs on WSL2
  return null;
}

/**
 * Detect the type of agent running this bridge
 */
function detectAgentType() {
  // Check environment hint (set by install.js)
  if (process.env.BUKOWSKI_AGENT_TYPE) {
    return process.env.BUKOWSKI_AGENT_TYPE;
  }

  // Check parent process
  try {
    const ppid = process.ppid;
    const cmdline = fs.readFileSync(`/proc/${ppid}/cmdline`, 'utf-8').toLowerCase();

    if (cmdline.includes('claude')) return 'claude';
    if (cmdline.includes('codex')) return 'codex';
    if (cmdline.includes('gemini')) return 'gemini';
  } catch {
    // Can't read proc
  }

  // Check common env vars
  if (process.env.CLAUDE_CODE_ENTRYPOINT) return 'claude';

  return 'unknown';
}

/**
 * Try to connect to bukowski (non-blocking, with short timeout)
 */
function tryConnectToBukowski() {
  if (connected || connecting) return;

  const socketPath = discoverSocket();
  if (!socketPath) return;

  connecting = true;
  socket = net.createConnection(socketPath);

  // Very short timeout - if not connected in 1 second, give up
  const connectTimeout = setTimeout(() => {
    if (!connected) {
      socket?.destroy();
      socket = null;
      connecting = false;
    }
  }, 1000);

  socket.on('connect', () => {
    clearTimeout(connectTimeout);
    connected = true;
    connecting = false;
    agentType = detectAgentType();

    // Use session agent ID if running inside bukowski, otherwise generate external ID
    const sessionAgentId = process.env.BUKOWSKI_AGENT_ID || null;

    // Send init message (fire and forget - don't block)
    // Include ancestor PIDs so MCPServer can match to session agent by PTY PID
    const initMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: '__init__',
      method: 'initialize',
      params: {
        agentType,
        agentId: sessionAgentId,      // null if external, set if session agent
        ancestorPids: getAncestorPids() // For session agent matching
      }
    }) + '\n';
    socket.write(initMsg);

    // If we have a session ID, use it directly
    if (sessionAgentId) {
      agentId = sessionAgentId;
    }
  });

  socket.on('data', (data) => {
    socketBuffer += data.toString();
    processSocketBuffer();
  });

  socket.on('error', () => {
    clearTimeout(connectTimeout);
    connected = false;
    connecting = false;
    socket = null;
  });

  socket.on('close', () => {
    connected = false;
    connecting = false;
    socket = null;
  });
}

/**
 * Process incoming data from bukowski socket
 */
function processSocketBuffer() {
  const lines = socketBuffer.split('\n');
  socketBuffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const response = JSON.parse(line);

      // Check for agentId in init response
      if (response.id === '__init__' && response.result?.assignedAgentId) {
        agentId = response.result.assignedAgentId;
      }

      // Route to pending request
      if (response.id && pendingRequests.has(response.id)) {
        const { resolve } = pendingRequests.get(response.id);
        pendingRequests.delete(response.id);
        resolve(response);
      }
    } catch {
      // Ignore parse errors
    }
  }
}

/**
 * Send a JSON-RPC request to bukowski socket
 */
function sendToSocket(request) {
  return new Promise((resolve, reject) => {
    if (!socket || !connected) {
      reject(new Error('Not connected to bukowski'));
      return;
    }

    pendingRequests.set(request.id, { resolve, reject });
    socket.write(JSON.stringify(request) + '\n');

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingRequests.has(request.id)) {
        pendingRequests.delete(request.id);
        reject(new Error('Request timeout'));
      }
    }, 30000);
  });
}

/**
 * Send JSON-RPC response to stdout
 */
function sendToStdout(response) {
  process.stdout.write(JSON.stringify(response) + '\n');
}

// Static tool definitions (available even when bukowski isn't running)
const TOOLS = [
  {
    name: 'fipa_request',
    description: 'Send a REQUEST performative to another agent asking them to perform an action',
    inputSchema: {
      type: 'object',
      required: ['to', 'action'],
      properties: {
        to: { type: 'string', description: 'Target agent ID (e.g., "claude-1", "codex-1")' },
        action: { type: 'string', description: 'The action to request the agent perform' }
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
        content: { type: 'string', description: 'The information to share' }
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
        proposition: { type: 'string', description: 'The yes/no question to ask' }
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
        reference: { type: 'string', description: 'Description of the information requested' }
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
    inputSchema: { type: 'object', properties: {} }
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

/**
 * Handle stdin input
 */
let stdinBuffer = '';
let pendingHandlers = 0;

function processStdin() {
  const lines = stdinBuffer.split('\n');
  stdinBuffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const request = JSON.parse(line);
      pendingHandlers++;
      handleRequest(request).finally(() => pendingHandlers--);
    } catch {
      sendToStdout({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' }
      });
    }
  }
}

/**
 * Handle a JSON-RPC request from the agent
 */
async function handleRequest(request) {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize':
      sendToStdout({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'bukowski-mcp-bridge', version: '1.0.0' }
        }
      });
      // Try connecting to bukowski in background
      tryConnectToBukowski();
      return;

    case 'initialized':
    case 'notifications/initialized':
      // Notifications don't get responses
      return;

    case 'tools/list':
      // Return static tools immediately (don't wait for bukowski)
      sendToStdout({
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS }
      });
      // Try connecting in background
      tryConnectToBukowski();
      return;

    case 'tools/call':
      // Try to forward to bukowski if connected
      if (connected) {
        try {
          const augmentedParams = { ...params };
          if (agentId && augmentedParams.arguments) {
            augmentedParams.arguments = {
              ...augmentedParams.arguments,
              _callerAgentId: agentId
            };
          }

          const response = await sendToSocket({
            jsonrpc: '2.0',
            id: `fwd_${id}`,
            method: 'tools/call',
            params: augmentedParams
          });

          sendToStdout({
            jsonrpc: '2.0',
            id,
            result: response.result || response.error
          });
        } catch (err) {
          sendToStdout({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `Error: ${err.message}` }],
              isError: true
            }
          });
        }
      } else {
        // Not connected to bukowski
        sendToStdout({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{
              type: 'text',
              text: 'bukowski is not running. Start bukowski first to enable agent communication.'
            }],
            isError: true
          }
        });
      }
      return;

    default:
      // Notifications (no id) don't get responses
      if (id === undefined || id === null || method?.startsWith('notifications/')) {
        return;
      }
      sendToStdout({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found' }
      });
  }
}

/**
 * Main entry point
 */
function main() {
  // Set up stdin handling immediately (don't block on bukowski connection)
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (data) => {
    stdinBuffer += data;
    processStdin();
  });

  process.stdin.on('end', async () => {
    const maxWait = 10000;
    const start = Date.now();
    while (pendingHandlers > 0 && Date.now() - start < maxWait) {
      await new Promise(r => setTimeout(r, 100));
    }
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    socket?.destroy();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    socket?.destroy();
    process.exit(0);
  });
}

main();
