#!/usr/bin/env node
// src/mcp/bukowski-mcp-bridge.js - Stdio-to-socket MCP bridge
// Translates MCP stdio transport to bukowski's Unix socket MCP server

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Discovery file location
const SOCKET_FILE = path.join(os.homedir(), '.bukowski-mcp-socket');

// Agent ID assigned by bukowski
let agentId = null;
let agentType = null;

// Socket connection
let socket = null;
let socketBuffer = '';
let connected = false;

// Pending requests waiting for responses
const pendingRequests = new Map();

/**
 * Discover bukowski's MCP socket
 * Priority: env var > discovery file > glob search
 */
function discoverSocket() {
  // 1. Check environment variable
  if (process.env.BUKOWSKI_MCP_SOCKET) {
    const envPath = process.env.BUKOWSKI_MCP_SOCKET;
    if (fs.existsSync(envPath)) {
      return envPath;
    }
  }

  // 2. Check discovery file
  try {
    const socketPath = fs.readFileSync(SOCKET_FILE, 'utf-8').trim();
    if (fs.existsSync(socketPath)) {
      return socketPath;
    }
  } catch {
    // File doesn't exist or can't be read
  }

  // 3. Search /tmp for bukowski-mcp-*.sock (most recent)
  try {
    const tmpDir = '/tmp';
    const files = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('bukowski-mcp-') && f.endsWith('.sock'))
      .map(f => {
        const fullPath = path.join(tmpDir, f);
        try {
          const stat = fs.statSync(fullPath);
          return { path: fullPath, mtime: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length > 0) {
      return files[0].path;
    }
  } catch {
    // Can't read /tmp
  }

  return null;
}

/**
 * Detect the type of agent running this bridge
 * Inspects parent process or environment
 */
function detectAgentType() {
  // Check environment hint
  if (process.env.BUKOWSKI_AGENT_TYPE) {
    return process.env.BUKOWSKI_AGENT_TYPE;
  }

  // Check argv[0] or ppid
  try {
    const ppid = process.ppid;
    const cmdline = fs.readFileSync(`/proc/${ppid}/cmdline`, 'utf-8');
    const cmd = cmdline.toLowerCase();

    if (cmd.includes('claude')) return 'claude';
    if (cmd.includes('codex')) return 'codex';
    if (cmd.includes('gemini')) return 'gemini';

    // Check parent's parent
    const stat = fs.readFileSync(`/proc/${ppid}/stat`, 'utf-8');
    const match = stat.match(/^\d+ \([^)]+\) \S (\d+)/);
    if (match) {
      const grandPpid = parseInt(match[1], 10);
      const grandCmdline = fs.readFileSync(`/proc/${grandPpid}/cmdline`, 'utf-8');
      const grandCmd = grandCmdline.toLowerCase();

      if (grandCmd.includes('claude')) return 'claude';
      if (grandCmd.includes('codex')) return 'codex';
      if (grandCmd.includes('gemini')) return 'gemini';
    }
  } catch {
    // Can't read proc - maybe not Linux
  }

  // Check common env vars that indicate the agent
  if (process.env.CLAUDE_CODE_ENTRYPOINT) return 'claude';
  if (process.env.CODEX_CLI) return 'codex';
  if (process.env.GEMINI_CLI) return 'gemini';

  // Default to 'unknown'
  return 'unknown';
}

/**
 * Connect to bukowski's MCP socket
 */
async function connectToBukowski() {
  const socketPath = discoverSocket();

  if (!socketPath) {
    return false;
  }

  return new Promise((resolve) => {
    socket = net.createConnection(socketPath);

    socket.on('connect', async () => {
      connected = true;

      // Register with bukowski
      agentType = detectAgentType();

      try {
        // Initialize connection
        const initResult = await sendToSocket({
          jsonrpc: '2.0',
          id: '__init__',
          method: 'initialize',
          params: { agentType }
        });

        // Check if we got an agentId back
        if (initResult?.result?.assignedAgentId) {
          agentId = initResult.result.assignedAgentId;
        }

        resolve(true);
      } catch (err) {
        resolve(false);
      }
    });

    socket.on('data', (data) => {
      socketBuffer += data.toString();
      processSocketBuffer();
    });

    socket.on('error', () => {
      connected = false;
      socket = null;
      resolve(false);
    });

    socket.on('close', () => {
      connected = false;
      socket = null;
    });

    // Timeout after 5 seconds
    setTimeout(() => {
      if (!connected) {
        socket?.destroy();
        socket = null;
        resolve(false);
      }
    }, 5000);
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

/**
 * Send error response for when bukowski is not running
 */
function sendNotRunningError(id) {
  sendToStdout({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: 'bukowski is not running. Start bukowski first to use agent communication tools.'
    }
  });
}

/**
 * Handle stdin input
 */
let stdinBuffer = '';
let pendingHandlers = 0;  // Track in-flight async handlers

async function processStdin() {
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

  // Handle MCP protocol methods locally
  switch (method) {
    case 'initialize':
      // MCP initialize - respond with our capabilities
      sendToStdout({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'bukowski-mcp-bridge',
            version: '1.0.0'
          }
        }
      });
      return;

    case 'initialized':
      // MCP initialized notification - no response needed
      return;

    case 'tools/list':
      // Forward to bukowski to get the tool list
      if (!connected) {
        const isConnected = await connectToBukowski();
        if (!isConnected) {
          // Return empty tools if not connected
          sendToStdout({
            jsonrpc: '2.0',
            id,
            result: {
              tools: [{
                name: 'bukowski_status',
                description: 'Check if bukowski is running (currently: NOT RUNNING)',
                inputSchema: { type: 'object', properties: {} }
              }]
            }
          });
          return;
        }
      }

      try {
        const response = await sendToSocket({
          jsonrpc: '2.0',
          id: `fwd_${id}`,
          method: 'tools/list',
          params: {}
        });

        // Add register_agent to the list if we have an ID
        const tools = response.result?.tools || [];

        sendToStdout({
          jsonrpc: '2.0',
          id,
          result: { tools }
        });
      } catch (err) {
        sendNotRunningError(id);
      }
      return;

    case 'tools/call':
      // Forward tool calls to bukowski
      if (!connected) {
        const isConnected = await connectToBukowski();
        if (!isConnected) {
          sendNotRunningError(id);
          return;
        }
      }

      try {
        // Inject agentId if we have one
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
          error: { code: -32000, message: err.message }
        });
      }
      return;

    default:
      // Unknown method
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
async function main() {
  // Try to connect to bukowski on startup
  await connectToBukowski();

  // Set up stdin handling
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (data) => {
    stdinBuffer += data;
    processStdin();
  });

  process.stdin.on('end', async () => {
    // Wait for pending handlers to complete before exiting
    const maxWait = 10000;  // 10 seconds max
    const start = Date.now();
    while (pendingHandlers > 0 && Date.now() - start < maxWait) {
      await new Promise(r => setTimeout(r, 100));
    }
    process.exit(0);
  });

  // Handle graceful shutdown
  process.on('SIGTERM', () => {
    socket?.destroy();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    socket?.destroy();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Bridge error:', err.message);
  process.exit(1);
});
