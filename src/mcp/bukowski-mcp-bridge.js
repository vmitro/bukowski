#!/usr/bin/env node
// src/mcp/bukowski-mcp-bridge.js - Stdio-to-socket MCP bridge
// Translates MCP stdio transport to bukowski's Unix socket MCP server

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { bridgeLog, logFilePath } = require('./bridgeLog');

/**
 * Get ancestor PIDs (for matching to session agent PTY PID)
 * Walks up the process tree up to 10 levels
 */
// Legacy path: the server now walks /proc itself from the `pid` we send (see
// src/utils/procTree.js). Kept for older servers, with the two bugs that made
// it miss fixed — it starts at our OWN pid, because a bridge that exec'd into
// the pane IS the pane, and it goes deep enough for a real pane's nesting
// (tmux -> shell -> wrapper -> REPL -> bridge).
function getAncestorPids() {
  const ancestors = [];
  let pid = process.pid;

  for (let i = 0; i < 64 && pid > 1; i++) {
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

// Discovery paths
const SOCKETS_DIR = path.join(os.homedir(), '.bukowski', 'sockets');
const LEGACY_SOCKET_FILE = path.join(os.homedir(), '.bukowski-mcp-socket');
const {
  isPidRunning,
  pidFromFileName,
  readInstanceMeta,
  isWithin,
  instanceCwd,
  instancesOwningCwd,
  instancesWithCwd,
  pidFromSocketPath,
  socketIsLive,
  chooseSocket,
  betterOwnerThan,
} = require('./socketDiscovery');


/**
 * Prune stale socket files (dead PID or missing socket path)
 */
function pruneStaleSocketFiles() {
  try {
    if (!fs.existsSync(SOCKETS_DIR)) return;
    const files = fs.readdirSync(SOCKETS_DIR);
    for (const file of files) {
      const pid = pidFromFileName(file);
      if (isNaN(pid)) continue;

      const filePath = path.join(SOCKETS_DIR, file);
      let shouldDelete = false;

      if (!isPidRunning(pid)) {
        // PID not running - stale
        shouldDelete = true;
      } else {
        // PID running but check if socket path exists
        try {
          const socketPath = fs.readFileSync(filePath, 'utf-8').trim();
          if (!fs.existsSync(socketPath)) {
            shouldDelete = true;
          }
        } catch {
          shouldDelete = true;
        }
      }

      if (shouldDelete) {
        try { fs.unlinkSync(`${filePath}.meta`); } catch { /* may not exist */ }
        try {
          fs.unlinkSync(filePath);
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

/**
 * Build diagnostic info for connection failures
 */
function getDiagnostics() {
  const lines = ['bukowski is not running (or bridge cannot connect)', ''];

  // Check env var
  const envSocket = process.env.BUKOWSKI_MCP_SOCKET;
  if (envSocket) {
    const exists = fs.existsSync(envSocket);
    lines.push(`BUKOWSKI_MCP_SOCKET=${envSocket} (${exists ? 'exists' : 'NOT FOUND'})`);
  } else {
    lines.push('BUKOWSKI_MCP_SOCKET=(not set)');
  }

  // Check sockets directory
  try {
    if (fs.existsSync(SOCKETS_DIR)) {
      const files = fs.readdirSync(SOCKETS_DIR);
      const active = files.filter(f => isPidRunning(parseInt(f, 10)));
      lines.push(`~/.bukowski/sockets/: ${active.length} active sessions (${files.length} total)`);
    } else {
      lines.push('~/.bukowski/sockets/: (not found)');
    }
  } catch {
    lines.push('~/.bukowski/sockets/: (cannot read)');
  }

  // Check legacy discovery file
  try {
    const discoveryPath = fs.readFileSync(LEGACY_SOCKET_FILE, 'utf-8').trim();
    const exists = fs.existsSync(discoveryPath);
    lines.push(`~/.bukowski-mcp-socket -> ${discoveryPath} (${exists ? 'exists' : 'NOT FOUND'})`);
  } catch {
    lines.push('~/.bukowski-mcp-socket: (not found)');
  }

  // Show ancestor PIDs for debugging
  const ancestors = getAncestorPids();
  lines.push(`Ancestor PIDs: ${ancestors.slice(0, 5).join(', ')}${ancestors.length > 5 ? '...' : ''}`);

  // What this bridge actually did, not just what the filesystem looks like.
  // The static tool list means the client still advertises every tool while
  // disconnected; saying so here is the only honest signal the agent gets.
  if (boundSocketPath) {
    lines.push(`Last bound: ${boundSocketPath} (via ${boundVia || 'unknown'})`);
  }
  if (lastDisconnect) {
    lines.push(`Link lost: ${lastDisconnect.reason}${lastDisconnect.detail ? ` (${lastDisconnect.detail})` : ''} at ${lastDisconnect.at}`);
  }
  lines.push(`Bridge log: ${logFilePath() || '(disabled)'}`);

  lines.push('', 'Start bukowski first, or check socket permissions.');
  return lines.join('\n');
}

// When this bridge is the channel-only server bundled in the bukowski channel
// plugin (loaded via `claude --channels plugin:...`), it carries the channel
// push but exposes NO tools — the tools come from the separate bare
// mcpServers.bukowski entry. Keeping the two servers split means the channel
// is purely additive: if the plugin path is misconfigured, tools are
// unaffected. bukowski routes channel notifications to the role=channel socket.
//
// The role is signalled BOTH as a CLI arg (--role=channel) and the env var.
// The arg is authoritative because Claude Code's channel loader
// (`--channels plugin:...`) drops a plugin .mcp.json's declared `env` when it
// spawns the server, but always forwards `args`. With env-only signalling the
// channel server silently ran in tools mode: it registered as a duplicate
// tools connection (no channel socket) AND advertised the full tool set, so
// Claude cycled it (~20s restarts) as a malformed channel.
const CHANNEL_ROLE = process.env.BUKOWSKI_BRIDGE_ROLE === 'channel'
  || process.argv.includes('--role=channel');

// Agent ID assigned by bukowski
let agentId = null;
let agentType = null;

// Socket connection
let socket = null;
let socketBuffer = '';
let connected = false;
let connecting = false;
let boundSocketPath = null;   // which instance we actually attached to
let boundVia = null;          // which discovery stage chose it
// The directory of the instance we last reached. A restart changes its pid and
// socket path but never this, so it is how we find the same seat again.
let boundInstanceCwd = null;
let everBound = false;
let connectedAt = 0;
// A down instance is retried every RECONNECT_INTERVAL_MS. Logging each attempt
// would bury the interesting lines, so a failure streak logs once and stays
// quiet until the next success.
let downLogged = false;
let lastDisconnect = null;    // {reason, detail, at, socket} — quoted in diagnostics

// Pending requests waiting for responses
const pendingRequests = new Map();

/**
 * Discover bukowski's MCP socket
 * Priority: env var (unless contradicted by cwd) > owning cwd >
 *           ancestor PID match (cwd-checked) > most recent > legacy file
 * Called dynamically on each connect attempt (not cached).
 * @returns {{socket: string, via: string, instance?: number}|null} — `via`
 *   names the stage that won, so a wrong binding is one grep away instead of a
 *   reconstruction from process ancestry.
 */
function discoverSocket() {
  // Prune stale files first
  pruneStaleSocketFiles();

  // 1-2. Explicit env override and cwd ownership, decided together.
  //
  // The env var is normally authoritative — bukowski sets it for its own child
  // agents. But it is only trustworthy when it was EARNED rather than
  // INHERITED. Claude Code pre-warms a `bg-spare` pool: a spare created by one
  // pane keeps that pane's BUKOWSKI_MCP_SOCKET and is later handed to a session
  // in another workspace, so an agent working in ~/projects bound to the
  // azra-agent instance and drained azra's claude-2 queue (bug-22). chooseSocket
  // overrides the env only when it names an instance that does not own our cwd
  // AND another running instance does.
  const envPath = process.env.BUKOWSKI_MCP_SOCKET || null;
  const owners = instancesOwningCwd(process.cwd());
  const choice = chooseSocket({
    envPath,
    // Liveness, not existence: a SIGKILLed instance leaves its socket file
    // behind and a bridge would dial it forever.
    envExists: socketIsLive(envPath),
    owners,
  });
  if (choice) {
    if (choice.via === 'cwd-override') {
      bridgeLog('env-overridden', {
        env: choice.overridden, cwd: process.cwd(), socket: choice.socket, bug: 'bug-22',
      });
    }
    return choice;
  }

  // 2.5. The instance we had before, back under a new pid.
  //
  // Reconnecting is the common case, not the exceptional one: the bridge
  // outlives the instance it serves (codex's app-server-daemon owns the
  // process) and retries every few seconds. Nothing below this line can tell
  // "my instance restarted" from "some instance exists", so without this the
  // first reconnect after a restart could land anywhere on the box.
  if (boundInstanceCwd) {
    const home = instancesWithCwd(boundInstanceCwd);
    if (home.length) return { socket: home[0].socket, via: 'sticky', instance: home[0].pid };
  }

  // 3. Ancestor PID matching (for processes genuinely in a bukowski's tree),
  // but only when that instance's cwd could plausibly contain us. Without the
  // check a shared daemon's ancestry silently outranks the truth.
  try {
    if (fs.existsSync(SOCKETS_DIR)) {
      const files = fs.readdirSync(SOCKETS_DIR);
      const ancestors = new Set(getAncestorPids());

      // Check if any socket file's PID is our ancestor
      for (const file of files) {
        const pid = pidFromFileName(file);
        if (!isNaN(pid) && ancestors.has(pid)) {
          const meta = readInstanceMeta(pid);
          // A cwd claim that cannot contain us means the ancestry crossed a
          // daemon boundary. No claim at all = pre-upgrade instance, trusted
          // as before.
          if (meta && !isWithin(meta.cwd, process.cwd())) continue;
          const socketPath = fs.readFileSync(path.join(SOCKETS_DIR, file), 'utf-8').trim();
          if (fs.existsSync(socketPath)) {
            return { socket: socketPath, via: 'ancestor', instance: pid };
          }
        }
      }

      // 4. Most recent active session (fallback for external tools).
      //
      // This is a guess, and only defensible for a bridge that has never had a
      // home: a bare REPL in a directory no instance owns is better off on
      // SOME instance than on none. For a bridge that WAS bound it is wrong by
      // construction — its instance is merely down, and attaching to an
      // unrelated one moves the agent onto another project's roster under a
      // name its correspondents have never seen. Observed in a test: a bridge
      // whose instance was killed reattached within 300ms to an instance in a
      // different repository.
      if (everBound) {
        if (!downLogged) {
          downLogged = true;
          bridgeLog('home-down', { instanceCwd: boundInstanceCwd, cwd: process.cwd() });
        }
        return null;
      }

      // Collect active sessions with mtime, sort by most recent first
      const activeSessions = [];
      for (const file of files) {
        const pid = pidFromFileName(file);
        if (!isNaN(pid) && isPidRunning(pid)) {
          const filePath = path.join(SOCKETS_DIR, file);
          try {
            const stat = fs.statSync(filePath);
            activeSessions.push({ filePath, mtime: stat.mtimeMs });
          } catch { /* ignore */ }
        }
      }
      activeSessions.sort((a, b) => b.mtime - a.mtime);

      // Return first one with valid socket path
      for (const { filePath } of activeSessions) {
        try {
          const socketPath = fs.readFileSync(filePath, 'utf-8').trim();
          if (fs.existsSync(socketPath)) {
            return { socket: socketPath, via: 'recent' };
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  // 5. Legacy discovery file (backwards compatibility)
  try {
    const socketPath = fs.readFileSync(LEGACY_SOCKET_FILE, 'utf-8').trim();
    if (fs.existsSync(socketPath)) {
      return { socket: socketPath, via: 'legacy' };
    }
  } catch { /* ignore */ }

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
 * Wait briefly for a connection, kicking off an attempt if none is in flight.
 *
 * The bridge used to attempt a connection ONLY from `initialize` and
 * `tools/list`, with no retry anywhere. When an instance restarted, its
 * bridges went permanently dead: `tools/list` still answered from the static
 * TOOLS array, so the client happily reported "bukowski: connected (38
 * tools)" while every `tools/call` fell through to a diagnostics blob. Agents
 * read that as "the tools are not available to me" and stopped trying.
 *
 * Daemon-spawned bridges make this the normal case rather than an edge one:
 * they are children of a machine-global pool, so they outlive the pane whose
 * instance they were bound to.
 */
function ensureConnected(timeoutMs = 1500) {
  if (connected) return Promise.resolve(true);
  tryConnectToBukowski();
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (connected) return resolve(true);
      if (Date.now() - start >= timeoutMs) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}

/**
 * The line that explains a session going quiet mid-flight.
 *
 * A dropped link is invisible from inside the agent: `tools/list` keeps
 * answering from the static array, so the client still shows the full tool set
 * and only a call reveals anything is wrong. `heldFor` separates the two causes
 * that look identical afterwards — an instance that was restarted (seconds to
 * hours of uptime, clean close) from one that never came up at all.
 */
function logDisconnect(reason, detail) {
  lastDisconnect = { reason, detail, at: new Date().toISOString(), socket: boundSocketPath };
  bridgeLog('disconnect', {
    reason,
    detail,
    socket: boundSocketPath,
    agent: agentId,
    heldForMs: connectedAt ? Date.now() - connectedAt : undefined,
  });
}

/**
 * Try to connect to bukowski (non-blocking, with short timeout)
 */
function tryConnectToBukowski() {
  if (connected || connecting) return;

  const choice = discoverSocket();
  if (!choice) {
    if (!downLogged) {
      downLogged = true;
      bridgeLog('no-socket', { cwd: process.cwd(), env: process.env.BUKOWSKI_MCP_SOCKET });
    }
    return;
  }
  const socketPath = choice.socket;

  connecting = true;
  boundSocketPath = socketPath;
  boundVia = choice.via;
  socket = net.createConnection(socketPath);

  // Timeout - if not connected in 5 seconds, give up
  const connectTimeout = setTimeout(() => {
    if (!connected) {
      if (!downLogged) {
        downLogged = true;
        bridgeLog('connect-failed', { socket: socketPath, via: choice.via, reason: 'timeout' });
      }
      socket?.destroy();
      socket = null;
      connecting = false;
    }
  }, 5000);

  socket.on('connect', () => {
    clearTimeout(connectTimeout);
    connected = true;
    connecting = false;
    connectedAt = Date.now();
    downLogged = false;
    everBound = true;
    boundInstanceCwd = instanceCwd(pidFromSocketPath(socketPath)) || boundInstanceCwd;
    agentType = detectAgentType();
    bridgeLog('connect', {
      socket: socketPath,
      via: choice.via,
      instanceCwd: boundInstanceCwd,
      instance: choice.instance ?? (pidFromSocketPath(socketPath) || undefined),
      agentType,
      envAgent: process.env.BUKOWSKI_AGENT_ID,
    });

    // Use session agent ID if running inside bukowski, otherwise generate external ID
    const sessionAgentId = process.env.BUKOWSKI_AGENT_ID || null;

    // Send init message (fire and forget - don't block)
    // Include ancestor PIDs so MCPServer can match to session agent by PTY PID,
    // and cwd so external agents get named after the directory they run in
    // (e.g. claude started in ~/azra registers as claude-azra-1).
    const initMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: '__init__',
      method: 'initialize',
      params: {
        agentType,
        agentId: sessionAgentId,      // null if external, set if session agent
        pid: process.pid,             // server walks /proc itself (see utils/procTree)
        ancestorPids: getAncestorPids(), // legacy: servers that predate `pid`
        cwd: process.cwd(),           // For external-agent host naming
        role: CHANNEL_ROLE ? 'channel' : undefined // routes channel pushes here
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

  socket.on('error', (err) => {
    clearTimeout(connectTimeout);
    if (connected) logDisconnect('error', err.message);
    else if (!downLogged) {
      downLogged = true;
      bridgeLog('connect-failed', { socket: socketPath, via: choice.via, reason: err.code || err.message });
    }
    connected = false;
    connecting = false;
    socket = null;
  });

  socket.on('close', () => {
    if (connected) logDisconnect('close');
    connected = false;
    connecting = false;
    socket = null;
  });
}

// Background reconnect. Without this a bridge only ever retried when the
// client happened to re-issue initialize/tools/list, so an instance restart
// stranded it indefinitely — and it kept reporting its static tool list, so
// nothing looked wrong until a call quietly returned diagnostics instead of a
// result. unref'd: this must never be the reason the process stays alive.
const RECONNECT_INTERVAL_MS = parseInt(process.env.BUKOWSKI_BRIDGE_RECONNECT_MS, 10) || 5000;
setInterval(() => {
  if (connecting) return;
  if (!connected) { tryConnectToBukowski(); return; }
  // Connected, but maybe to the wrong instance: re-evaluate ownership. Skip
  // while calls are in flight so a rebind never drops a pending response.
  if (pendingHandlers > 0) return;
  const better = betterOwnerThan(boundSocketPath, instancesOwningCwd(process.cwd()));
  if (better) {
    bridgeLog('rebind', {
      from: boundSocketPath, to: better.socket, cwd: process.cwd(), bug: 'bug-25',
    });
    socket?.destroy();   // close handler clears state; next tick reconnects
  }
}, RECONNECT_INTERVAL_MS).unref();

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
        const assigned = response.result.assignedAgentId;
        // A changed id after a reconnect is not cosmetic: every agent holding
        // the old one addresses a seat that no longer exists.
        bridgeLog('identify', {
          agent: assigned,
          socket: boundSocketPath,
          via: boundVia,
          previous: agentId && agentId !== assigned ? agentId : undefined,
          changed: agentId && agentId !== assigned ? true : undefined,
        });
        agentId = assigned;
        continue;
      }

      // Route to pending request
      if (response.id && pendingRequests.has(response.id)) {
        const { resolve } = pendingRequests.get(response.id);
        pendingRequests.delete(response.id);
        resolve(response);
        continue;
      }

      // Server-initiated notification (has a method, no matching request):
      // forward it verbatim to the agent over stdio. This is the path that
      // carries notifications/claude/channel pushes. Without this the bridge
      // dropped every server->client message, which is why channel events
      // (and the old tools/list_changed) never reached Claude Code.
      if (response.method && (response.id === undefined || response.id === null)) {
        sendToStdout(response);
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
        proposition: { type: 'string', description: 'The yes/no question to ask. (Named per FIPA, not "content" — but you may pass it as "content" too.)' },
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
        reference: { type: 'string', description: 'Description of the information requested. (Named per FIPA, not "content" — but you may pass it as "content" too.)' },
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
    description: 'Send an AGREE performative to accept a request. Pass `content` to say what you are agreeing to do — a bare agree reads as silence.',
    inputSchema: {
      type: 'object',
      required: ['to', 'conversationId'],
      properties: {
        to: { type: 'string', description: 'Target agent ID' },
        content: { type: 'string', description: 'What you are agreeing to, in your own words (optional but strongly preferred)' },
        conversationId: { type: 'string', description: 'The conversation ID to agree to (required: an agree with no thread is an agree to nothing)' },
        inReplyTo: { type: 'string', description: 'Message id this answers, to link the reply to the exact message' }
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
    description: 'List every addressable agent: local session agents, external bridge clients, and federated peers. Address an agent by its `id` OR by any name in its `aliases` (a session agent also answers to its federated `claude-<host>-N` form). Anything not listed here is not routable.',
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
  },
  ...require('./dashboardTools').DASHBOARD_TOOLS,
  ...require('./eventTools').EVENT_TOOLS
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
          // experimental['claude/channel'] advertises Claude Code "channels".
          // This response is what Claude Code's MCP client actually reads (it
          // talks to the bridge, not the bukowski socket directly), so the
          // capability MUST be declared here for channel pushes to be accepted.
          // Unknown capability keys are ignored by older clients, so this is
          // safe to always send.
          capabilities: {
            tools: {},
            experimental: { 'claude/channel': {} }
          },
          serverInfo: { name: 'bukowski-mcp-bridge', version: '1.0.0' }
        }
      });
      // What the CLIENT told us about itself.
      //
      // A codex tools seat is renumbered on every daemon bounce because the
      // only thing we can key a stable seat on is the bridge's pid, and the
      // daemon spawns a fresh bridge each time. The fix needs a handle that
      // outlives the process — a codex conversation or session id would do —
      // and the client's own initialize is the one place such a thing could
      // arrive. Record what is actually offered instead of guessing: keys
      // only, plus clientInfo, so a session id shows up by name without
      // logging whatever else the params carry.
      bridgeLog('client-initialize', {
        client: params?.clientInfo?.name,
        clientVersion: params?.clientInfo?.version,
        protocol: params?.protocolVersion,
        paramKeys: params ? Object.keys(params).join(',') : null,
        clientInfoKeys: params?.clientInfo ? Object.keys(params.clientInfo).join(',') : null,
      });
      // Try connecting to bukowski in background
      tryConnectToBukowski();
      return;

    case 'initialized':
    case 'notifications/initialized':
      // Notifications don't get responses
      return;

    case 'tools/list':
      // Return static tools immediately (don't wait for bukowski). The
      // channel-only role exposes no tools so it doesn't duplicate the bare
      // server's fipa_* tools under a second namespace.
      {
        const tools = CHANNEL_ROLE ? [] : TOOLS;
        sendToStdout({ jsonrpc: '2.0', id, result: { tools } });
        // The one line that says whether a client ever asked, and what it was
        // handed. A client that caches this answer for the lifetime of its
        // conversation — codex does — will not ask twice, so an empty or
        // stale-looking registry later is explained by this timestamp and
        // nothing after it (tip-13).
        bridgeLog('tools-list', {
          count: tools.length,
          agent: agentId,
          connected,
          socket: boundSocketPath,
          role: CHANNEL_ROLE ? 'channel' : undefined,
        });
      }
      // Try connecting in background
      tryConnectToBukowski();
      return;

    case 'tools/call':
      // Forward to bukowski, reconnecting first if the link dropped (an
      // instance restart used to strand the bridge for good).
      if (connected || await ensureConnected()) {
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

          // MCP tool responses must be `{content: [...], isError?}`. Stuffing
          // the raw `error` object into `result` produced a shape Claude Code
          // renders as "completed with no output" — server errors (e.g.
          // "Unknown agent" when the federation roster is stale at the moment
          // of an fipa_* call) were invisible to the sender, looking like
          // silent success. Wrap errors in a proper isError content payload.
          if (response.result) {
            sendToStdout({ jsonrpc: '2.0', id, result: response.result });
          } else if (response.error) {
            const msg = response.error.message || JSON.stringify(response.error);
            sendToStdout({
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: `bukowski error: ${msg}` }],
                isError: true
              }
            });
          } else {
            sendToStdout({
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: 'bukowski returned no result and no error' }],
                isError: true
              }
            });
          }
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
        // Not connected to bukowski - show diagnostic info
        bridgeLog('degraded-call', {
          tool: params?.name,
          agent: agentId,
          socket: boundSocketPath,
          lastDisconnect: lastDisconnect?.reason,
        });
        sendToStdout({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{
              type: 'text',
              text: getDiagnostics()
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
  bridgeLog('start', {
    cwd: process.cwd(),
    role: CHANNEL_ROLE ? 'channel' : 'tools',
    envSocket: process.env.BUKOWSKI_MCP_SOCKET,
    envAgent: process.env.BUKOWSKI_AGENT_ID,
    ppid: process.ppid,
  });

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

  // A bridge that is killed and a link that drops look identical from the
  // agent's side; only the log can tell them apart afterwards.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      bridgeLog('stop', { signal: sig, agent: agentId, socket: boundSocketPath, connected });
      socket?.destroy();
      process.exit(0);
    });
  }
}

main();
