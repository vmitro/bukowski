#!/usr/bin/env node
// bukowski multi-agent terminal - v1.1

const path = require('path');
const fs = require('fs');

// Bootstrap module
const {
  SOCKETS_DIR,
  SOCKET_DISCOVERY_FILE,
  LEGACY_SOCKET_FILE,
  FIPA_REMINDER,
  findClaudePath,
  findCodexPath,
  createAgentTypes,
  getFIPAPromptArgs,
  resolveAgentType,
  loadQuotes,
  showSplash,
  parseArgs
} = require('./src/bootstrap');
const os = require('os');

const { Session } = require('./src/core/Session');
const { Agent } = require('./src/core/Agent');
const { ChatAgent } = require('./src/core/ChatAgent');
const { LayoutManager } = require('./src/layout/LayoutManager');
const { Compositor } = require('./src/core/Compositor');
const { InputRouter } = require('./src/input/InputRouter');
const { IPCHub } = require('./src/ipc/IPCHub');
const { FIPAHub } = require('./src/acl/FIPAHub');
const { TabBar } = require('./src/ui/TabBar');
const { ChatPane } = require('./src/ui/ChatPane');
const { ConversationList } = require('./src/ui/ConversationList');
const { ConversationPicker } = require('./src/ui/ConversationPicker');
const { LayoutNode } = require('./src/layout/LayoutNode');
const { RegisterManager } = require('./src/input/RegisterManager');
const { findLatestSession } = require('./src/utils/agentSessions');
const { OverlayManager } = require('./src/ui/OverlayManager');
const { MCPServer } = require('./src/mcp/MCPServer');
const {
  extractSelectedText,
  extractLines,
  extractWord,
  extractToEndOfLine,
  extractFromStartOfLine,
  isWordChar,
  moveWordForward,
  moveWordEnd,
  moveWordBackward,
  findCharOnLine
} = require('./src/utils/bufferText');
const { TerminalManager } = require('./src/core/TerminalManager');
const { CommandExecutor } = require('./src/core/CommandExecutor');
const { ActionDispatcher } = require('./src/handlers');

// Initialize agent types with discovered CLI paths
const claudePath = findClaudePath();
const codexPath = findCodexPath();
const AGENT_TYPES = createAgentTypes(claudePath, codexPath);

// Lazy-initialized UI singletons (set later in startup)
let chatPane = null;
let compositor = null;

// Load quotes for splash screen
const quotesPath = path.join(__dirname, 'quotes.txt');
const QUOTES = loadQuotes(quotesPath);

const cliArgs = parseArgs();

// Optional debug logging to a file (captures console logs/errors) without polluting stdout
let logStream = null;
function enableFileLogging() {
  const logFilePath = process.env.BUKOWSKI_LOG_FILE || 'bukowski.log';
  logStream = fs.createWriteStream(path.resolve(logFilePath), { flags: 'a' });
  console.log = (...args) => {
    try {
      logStream.write(`${new Date().toISOString()} [INFO] ${args.join(' ')}\n`);
    } catch { /* ignore logging errors */ }
  };
  console.error = (...args) => {
    try {
      logStream.write(`${new Date().toISOString()} [ERROR] ${args.join(' ')}\n`);
    } catch { /* ignore logging errors */ }
  };
}
enableFileLogging();

// Activate file logging so console.log/error go to bukowski.log instead of stderr
enableFileLogging();

// Single-pane mode: exec single.js and exit
if (cliArgs.single) {
  const singlePath = path.join(__dirname, 'single.js');
  const { spawnSync } = require('child_process');
  const result = spawnSync(process.execPath, [singlePath, ...cliArgs.agentArgs], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env
  });
  process.exit(result.status || 0);
}

// Terminal manager - handles setup/cleanup and signal handlers
const terminal = new TerminalManager(SOCKET_DISCOVERY_FILE, LEGACY_SOCKET_FILE);
terminal.registerSignalHandlers();

// Main async startup
(async () => {
  // Enter alt screen
  process.stdout.write('\x1b[?1049h');

  // Show splash
  showSplash(QUOTES);

  const SPLASH_DURATION = parseInt(process.env.BUKOWSKI_SPLASH) || 2000;

  // Wait for splash duration
  await new Promise(resolve => setTimeout(resolve, SPLASH_DURATION));

  // Continue with main initialization
  let session;
  let restoredSession = false;
  let pendingSessionData = null; // Raw session data to restore after FIPAHub is created

  // Try to restore session if requested
  if (cliArgs.restore) {
    try {
      const { LayoutNode } = require('./src/layout/LayoutNode');
      // Load session without conversations (will restore those after FIPAHub exists)
      if (cliArgs.restore === 'latest') {
        session = await Session.loadLatest(Agent, LayoutNode);
      } else {
        session = await Session.loadByIdOrName(cliArgs.restore, Agent, LayoutNode);
      }
      if (session) {
        restoredSession = true;
        // Load raw data to get conversations
        const sessionDir = Session.getSessionDir();
        const filepath = path.join(sessionDir, `${session.id}.json`);
        try {
          pendingSessionData = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
        } catch { /* ignore */ }
      }
    } catch (err) {
      // Failed to restore, will create new session
      // Log to stderr so it doesn't interfere with terminal
      process.stderr.write(`Failed to restore session: ${err.message}\n`);
    }
  }

  // Create new session if not restored
  if (!session) {
    const sessionName = cliArgs.sessionName || process.env.BUKOWSKI_SESSION || 'Main';
    session = new Session(sessionName);

    // Create initial Claude agent
    // Inject FIPA reminder if user didn't provide their own prompt
    const claudeConfig = AGENT_TYPES.claude;
    const initialArgs = [...claudeConfig.args, ...cliArgs.agentArgs];
    const fipaArgs = getFIPAPromptArgs(AGENT_TYPES, 'claude', initialArgs);
    const claude = new Agent({
      id: 'claude-1',
      name: claudeConfig.name,
      type: 'claude',
      command: claudeConfig.command,
      args: [...initialArgs, ...fipaArgs],
      autostart: true
    });

    session.addAgent(claude);
    session.layout = new (require('./src/layout/LayoutNode').Pane)(claude.id);
  }

  // Initialize layout manager
  const layoutManager = new LayoutManager(session);

  // Restore focus or default to first pane
  if (restoredSession && session.focusedPaneId) {
    layoutManager.focusedPaneId = session.focusedPaneId;
  } else {
    const panes = layoutManager.getAllPanes();
    if (panes.length > 0) {
      layoutManager.focusedPaneId = panes[0].id;
    }
  }

  // Create TabBar
  const tabBar = new TabBar();

  // Start IPC hub
  const ipcHub = new IPCHub(session);
  try {
    await ipcHub.start();
    session.ipcHub = ipcHub;
  } catch (err) {
    // IPC is optional - continue without it
    console.error('Warning: IPC hub failed to start:', err.message);
  }

  // Chat error buffer (needs to exist before FIPAHub init so catch blocks can push)
  const pendingChatErrors = [];
  const maxPendingChatErrors = 200;
  const stripAnsi = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, '');

  // Start FIPA Hub
  const fipaHub = new FIPAHub(ipcHub);
  try {
    // Restore conversations from saved session if available
    if (pendingSessionData?.conversations) {
      fipaHub.conversations.restoreFromJSON(pendingSessionData.conversations);
    }

    // Restore chat agents from saved session (they were skipped during initial load
    // because FIPAHub didn't exist yet)
    if (pendingSessionData?.agents) {
      for (const agentData of pendingSessionData.agents) {
        if (agentData.type === 'chat' && agentData.conversationId) {
          // Check if we don't already have this agent
          if (!session.getAgent(agentData.id)) {
            const chatAgent = ChatAgent.fromJSON(agentData, fipaHub.conversations, fipaHub);
            // Set available agents for target selection
            const realAgents = session.getAllAgents().filter(a => a.type !== 'chat');
            chatAgent.setAvailableAgents(realAgents);
            session.addAgent(chatAgent);
            flushPendingChatErrors();
          }
        }
      }
    }
  } catch (err) {
    console.error('Warning: FIPA hub failed to initialize:', err.message);
  }

  function getChatAgents() {
    return session.getAllAgents().filter(agent => agent.type === 'chat' && typeof agent.addErrorMessage === 'function');
  }

  function flushPendingChatErrors() {
    if (pendingChatErrors.length === 0) return;
    const chatAgents = getChatAgents();
    if (chatAgents.length === 0) return;
    const lines = pendingChatErrors.splice(0, pendingChatErrors.length);
    for (const line of lines) {
      for (const agent of chatAgents) {
        agent.addErrorMessage(line);
      }
    }
  }

  function broadcastChatError(text) {
    const cleaned = stripAnsi(text || '').replace(/\r/g, '');
    const lines = cleaned.split('\n').map(line => line.trimEnd()).filter(Boolean);
    if (lines.length === 0) return;

    const chatAgents = getChatAgents();
    if (chatAgents.length === 0) {
      pendingChatErrors.push(...lines);
      if (pendingChatErrors.length > maxPendingChatErrors) {
        pendingChatErrors.splice(0, pendingChatErrors.length - maxPendingChatErrors);
      }
      return;
    }

    for (const line of lines) {
      for (const agent of chatAgents) {
        agent.addErrorMessage(line);
      }
    }
  }

  // Broadcast informational/system announcements to all chat surfaces
  function broadcastSystemMessage(text) {
    if (!text) return;

    if (chatPane) {
      chatPane.addSystemMessage(text);
    }

    for (const agent of getChatAgents()) {
      if (typeof agent.addSystemMessage === 'function') {
        agent.addSystemMessage(text);
      }
    }

    if (compositor) {
      compositor.scheduleDraw();
    }
  }

  // Agent output logging to bukowski.log (only active when enableFileLogging() called)
  const agentLogBuffers = new Map();
  const agentLogQueue = [];
  let agentLogScheduled = false;
  const ANSI_CSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
  const ANSI_OSC_RE = /\x1b\][^\x07]*\x07/g;
  const NEWLINE_RE = /\r?\n/;

  // Per-agent dedup state: when a TUI repaints the same line many times in a
  // row (status bars, test progress, "Cooking…" tickers) we collapse the runs
  // into a single trailing "× N" marker emitted on the next distinct line.
  // Without this, bukowski.log grows by GB on long sessions.
  const agentLogLastLine = new Map(); // agentId -> last cleaned line written
  const agentLogRepeats = new Map();  // agentId -> repeat count since last write

  function flushAgentLogQueue() {
    agentLogScheduled = false;
    if (agentLogQueue.length === 0 || !logStream) return;
    const entries = agentLogQueue.splice(0, agentLogQueue.length);
    const timestamp = new Date().toISOString();
    for (const { agentId, line } of entries) {
      try {
        const clean = line.replace(ANSI_CSI_RE, '').replace(ANSI_OSC_RE, '');
        if (!clean.trim()) continue;
        if (agentLogLastLine.get(agentId) === clean) {
          agentLogRepeats.set(agentId, (agentLogRepeats.get(agentId) || 0) + 1);
          continue;
        }
        const repeats = agentLogRepeats.get(agentId) || 0;
        if (repeats > 0) {
          logStream.write(`${timestamp} [AGENT ${agentId}] (× ${repeats + 1})\n`);
          agentLogRepeats.set(agentId, 0);
        }
        logStream.write(`${timestamp} [AGENT ${agentId}] ${clean}\n`);
        agentLogLastLine.set(agentId, clean);
      } catch { /* ignore logging errors */ }
    }
  }

  function logAgentData(agentId, chunk) {
    if (!chunk || !logStream) return;
    const buffer = agentLogBuffers.get(agentId) || '';
    const text = buffer + (typeof chunk === 'string' ? chunk : chunk.toString());
    const parts = text.split(NEWLINE_RE);
    agentLogBuffers.set(agentId, parts.pop() || '');
    for (const line of parts) {
      if (line) agentLogQueue.push({ agentId, line });
    }
    if (!agentLogScheduled && agentLogQueue.length > 0) {
      agentLogScheduled = true;
      setImmediate(flushAgentLogQueue);
    }
  }

  // Respawn an agent once without resume args when a stale session ID causes launch failure.
  function respawnAgentWithoutResume(agent) {
    const pane = layoutManager.findPaneByAgent(agent.id);
    const typeConfig = AGENT_TYPES[agent.type];
    if (!pane || !typeConfig) return false;

    // Build fresh args without resume, plus FIPA prompt
    // Rebuild command too: saved command may be stale (e.g. 'node' from a prior install
    // with a local claude entrypoint, while current install uses 'claude' from PATH)
    const baseArgs = typeConfig.args || [];
    const combinedArgs = [...baseArgs];
    const fipaArgs = getFIPAPromptArgs(AGENT_TYPES, agent.type, combinedArgs);
    agent.command = typeConfig.command;
    agent.args = [...combinedArgs, ...fipaArgs];
    agent.agentSessionId = null;
    agent.exitCode = null;
    agent.status = 'stopped';

    agent.spawn(pane.bounds.width, pane.bounds.height);
    setupAgentHandlers(agent);
    agent.terminal?.write('\r\n\x1b[33m[resume failed; respawned fresh without session]\x1b[0m\r\n');
    broadcastChatError(`${agent.id} resume failed; respawned fresh session`);
    return true;
  }

  function handleAgentExit(agent, exitCode) {
    if (exitCode !== 0) {
      // If resume failed due to stale session, retry once without resume args
      if (agent.agentSessionId && !agent._retriedWithoutResume) {
        agent._retriedWithoutResume = true;
        const restarted = respawnAgentWithoutResume(agent);
        if (restarted) {
          compositor.scheduleDraw();
          return;
        }
      }

      // Keep the pane open on errors so the user can see the failure.
      const msg = `\r\n\x1b[31m[process exited with code ${exitCode}]\x1b[0m\r\n`;
      agent.terminal?.write(msg);
      if (!agent._reportedExit) {
        agent._reportedExit = true;
        broadcastChatError(`${agent.id} exited with code ${exitCode}`);
      }
      compositor.scheduleDraw();
      return;
    }

    // Find and close the pane for this agent
    const pane = layoutManager.findPaneByAgent(agent.id);
    if (pane) {
      // Focus this pane first so closePane() closes the right one
      layoutManager.focusPane(pane.id);

      const allPanes = layoutManager.getAllPanes();
      if (allPanes.length === 1) {
        // Last pane - quit entirely
        terminal.cleanup();
        if (ipcHub) ipcHub.stop();
        session.destroy();
        process.exit(exitCode);
      } else {
        // Close just this pane
        const paneId = pane.id;
        layoutManager.closePane();
        compositor.cleanupPane(paneId);  // Clear reflow timers and state

        // Announce agent departure in chat (skip chat agents)
        if (agent.type !== 'chat') {
          broadcastSystemMessage(`${agent.name} (${agent.id}) left the session`);
        }

        session.removeAgent(agent.id);
        handleResize();
      }
    }
  }

  const stderrWrite = process.stderr.write.bind(process.stderr);
  let stderrBuffer = '';
  process.stderr.write = (chunk, encoding, callback) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString(encoding || 'utf8');
    stderrBuffer += text;
    const parts = stderrBuffer.split(/\r?\n/);
    stderrBuffer = parts.pop() || '';
    for (const line of parts) {
      broadcastChatError(line);
    }
    return stderrWrite(chunk, encoding, callback);
  };

  // Start MCP Server for agent tool communication
  const mcpServer = new MCPServer(session, fipaHub, ipcHub);
  try {
    const socketPath = await mcpServer.start();

    // Set socket path in process.env so spawned agents inherit it
    // This ensures agents connect to THIS instance's MCP server, not another instance's
    process.env.BUKOWSKI_MCP_SOCKET = socketPath;

    // Wire FIPAHub messages to MCP message queue and PTY injection
    const fipaPromptDelayMs = parseInt(process.env.BUKOWSKI_FIPA_PROMPT_DELAY_MS, 10) || 100;
    const fipaSubmitDelayMs = parseInt(process.env.BUKOWSKI_FIPA_SUBMIT_DELAY_MS, 10) || 80; // Legacy fixed delay
    let fipaEchoTimeoutMs = parseInt(process.env.BUKOWSKI_FIPA_ECHO_TIMEOUT_MS, 10) || 1000; // Max wait per attempt
    const fipaQuietMs = parseInt(process.env.BUKOWSKI_FIPA_QUIET_MS, 10) || 250; // Required PTY-quiet window before injecting
    const fipaQuietMaxWaitMs = parseInt(process.env.BUKOWSKI_FIPA_QUIET_MAX_WAIT_MS, 10) || 3000; // Max time to wait for quiet
    const fipaMaxAttempts = parseInt(process.env.BUKOWSKI_FIPA_MAX_ATTEMPTS, 10) || 2; // Echo attempts before giving up

    // Per-agent FIFO to prevent overlapping injections from racing.
    const fipaInjectQueues = new Map(); // agentId -> Promise chain

    // Last time we saw bytes from each agent's PTY; used to detect quiet windows
    // before injecting. Keyed by agent.id; populated via tapPtyForFipaQuiet().
    const lastPtyDataAt = new Map();
    const ptyTapped = new Set();
    function tapPtyForFipaQuiet(agent) {
      if (!agent?.pty) return;
      if (ptyTapped.has(agent.id)) return;
      ptyTapped.add(agent.id);
      lastPtyDataAt.set(agent.id, Date.now());
      agent.pty.onData(() => { lastPtyDataAt.set(agent.id, Date.now()); });
    }

    function awaitPtyQuiet(agent, quietMs, maxWaitMs) {
      return new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
          const last = lastPtyDataAt.get(agent.id) || 0;
          if (Date.now() - last >= quietMs) return resolve(true);
          if (Date.now() - start >= maxWaitMs) return resolve(false);
          setTimeout(tick, Math.max(20, Math.min(quietMs, 50)));
        };
        tick();
      });
    }

    function enqueueFipaInject(agent, prompt) {
      if (!agent?.pty) return;
      const prev = fipaInjectQueues.get(agent.id) || Promise.resolve();
      const task = () => injectFipaWithEcho(agent, prompt).catch(() => { /* swallow to keep chain alive */ });
      const next = prev.then(task, task);
      fipaInjectQueues.set(agent.id, next);
    }

    // One write+wait-for-echo attempt. Resolves to 'echoed' | 'timeout'.
    function injectFipaAttempt(agent, prompt) {
      return new Promise((resolve) => {
        let done = false;
        let buffer = '';
        const maxBuffer = Math.max(prompt.length * 2, 256);
        const settle = (outcome, disposable, timer) => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          if (disposable?.dispose) disposable.dispose();
          resolve(outcome);
        };
        const timer = setTimeout(() => settle('timeout', dataListener, timer), fipaEchoTimeoutMs);
        const dataListener = agent.pty.onData((data) => {
          if (done) return;
          buffer += data;
          if (buffer.length > maxBuffer) buffer = buffer.slice(-maxBuffer);
          if (buffer.includes(prompt)) settle('echoed', dataListener, timer);
        });
        agent.pty.write(prompt);
      });
    }

    // Inject text into an agent PTY: wait for a quiet window first, then write
    // and wait for the echo before sending Enter. Retry on echo timeout. If we
    // never see the echo, clear the input line (Ctrl+U) instead of submitting
    // a stray fragment — the message is still in the MCP queue, the agent will
    // pick it up via get_pending_messages.
    async function injectFipaWithEcho(agent, prompt) {
      if (!agent?.pty) return;
      tapPtyForFipaQuiet(agent);
      await awaitPtyQuiet(agent, fipaQuietMs, fipaQuietMaxWaitMs);

      for (let attempt = 1; attempt <= fipaMaxAttempts; attempt++) {
        const outcome = await injectFipaAttempt(agent, prompt);
        if (outcome === 'echoed') {
          agent.pty.write('\r');
          return;
        }
        if (attempt < fipaMaxAttempts) {
          // Wipe what we just wrote and let the PTY settle before retrying.
          try { agent.pty.write('\x15'); } catch { /* ignore */ }
          await awaitPtyQuiet(agent, fipaQuietMs, fipaQuietMaxWaitMs);
        }
      }
      // Final failure: clear the input line so we don't submit garbage. The
      // payload is still queued in MCP for get_pending_messages.
      try { agent.pty.write('\x15'); } catch { /* ignore */ }
      console.log(`[fipa-autoinject] echo timeout for ${agent.id} after ${fipaMaxAttempts} attempts; cleared input, message remains in MCP queue`);
    }

    fipaHub.on('fipa:sent', ({ message, to }) => {
      if (!to) return;

      // Queue for MCP polling
      mcpServer.queueMessage(to, message);

      // For session agents with PTY, inject and auto-submit to trigger response
      const agent = session.getAgent(to);
      if (agent?.pty && message.sender?.name !== to) {
        let prompt = formatFIPAForPTY(message);
        // Gemini uses ! for shell mode - replace with . to avoid triggering it
        if (agent.type === 'gemini') {
          prompt = prompt.replace(/!/g, '.');
        }
        // Small delay to not interrupt mid-output
        setTimeout(() => {
          enqueueFipaInject(agent, prompt);
        }, fipaPromptDelayMs);
      } else if (agent?.type === 'chat') {
        const prompt = formatFIPAForPTY(message);
        agent.write(prompt);
      }
    });

    // Format FIPA message for PTY injection (no trailing newline - sent separately)
    // Short messages: include content. Long messages: just notify to check inbox.
    function formatFIPAForPTY(message) {
      const sender = message.sender?.name || 'unknown';
      const perf = message.performative || 'inform';
      // null/undefined content is legitimate (e.g. fipa_agree) — render as empty
      // rather than letting JSON.stringify(undefined) return undefined and crash .replace below.
      let content;
      if (typeof message.content === 'string') {
        content = message.content;
      } else if (message.content == null) {
        content = '';
      } else {
        content = JSON.stringify(message.content, null, 2);
      }

      // Escape newlines for single-line input
      const escaped = content.replace(/\n/g, ' ');

      // Short messages: include full content
      // Long messages: just notify, tell them to check inbox
      const MAX_INLINE = 200;
      if (escaped.length <= MAX_INLINE) {
        return `[FIPA ${perf} from ${sender}]: ${escaped}`;
      } else {
        const preview = escaped.slice(0, 80) + '...';
        return `[FIPA ${perf} from ${sender}]: ${preview} (use get_pending_messages for full text)`;
      }
    }

    // Write socket path to discovery files for MCP bridge
    try {
      // Create sockets directory (recursive to also create .bukowski if needed)
      fs.mkdirSync(SOCKETS_DIR, { recursive: true });
      // Per-PID socket file for ancestor matching
      fs.writeFileSync(SOCKET_DISCOVERY_FILE, socketPath, 'utf-8');
      // Legacy discovery file for backwards compatibility
      fs.writeFileSync(LEGACY_SOCKET_FILE, socketPath, 'utf-8');
      // Env var for child agents (primary discovery method)
      process.env.BUKOWSKI_MCP_SOCKET = socketPath;
      // Track socket path for cleanup (only delete legacy if still ours)
      terminal.setSocketPath(socketPath);
    } catch {
      // Ignore - discovery file is optional
    }
  } catch (err) {
    console.error('Warning: MCP server failed to start:', err.message);
  }

  // Create FIPA UI components
  const conversationList = new ConversationList(fipaHub.conversations);
  chatPane = new ChatPane(fipaHub.conversations);

  // Wire MCPServer agent connect/disconnect notifications to chat
  mcpServer.on('external_agent:connected', ({ agentId }) => {
    broadcastSystemMessage(`${agentId} joined the session`);
  });
  mcpServer.on('external_agent:disconnected', (agentId) => {
    broadcastSystemMessage(`${agentId} left the session`);
  });

  // Create overlay manager for modal UIs (ACL input, agent picker, etc.)
  const overlayManager = new OverlayManager();

  // Create compositor
  compositor = new Compositor(session, layoutManager, tabBar, chatPane, conversationList, overlayManager);
  compositor.startCursorBlink();

  // Optional compositor health logging for debugging pane slowdowns
  const metricsIntervalMs = parseInt(process.env.BUKOWSKI_COMPOSITOR_METRICS_MS, 10) || 0;

  // Wrap compositor.draw to collect timing/frequency stats
  let drawCount = 0;
  let drawTimeTotal = 0;
  let metricsTimer = null;
  if (metricsIntervalMs > 0 && compositor && typeof compositor.draw === 'function') {
    const originalDraw = compositor.draw.bind(compositor);
    compositor.draw = (...args) => {
      const start = performance.now();
      const result = originalDraw(...args);
      drawCount++;
      drawTimeTotal += performance.now() - start;
      return result;
    };
  }
  if (metricsIntervalMs > 0) {
    metricsTimer = setInterval(() => {
      const ts = new Date().toISOString();
      const panes = layoutManager.getAllPanes();
      const paneCount = panes.length;
      const paneHeights = panes.map(p => {
        const a = session.getAgent(p.agentId);
        return a ? a.getContentHeight() : 0;
      });
      const maxContentHeight = paneHeights.length ? Math.max(...paneHeights) : 0;

      const drawStats = {
        draws: drawCount,
        avgMs: drawCount ? +(drawTimeTotal / drawCount).toFixed(2) : 0
      };
      drawCount = 0;
      drawTimeTotal = 0;

      const metrics = {
        panes: paneCount,
        frameCache: compositor.frameCache?.size || 0,
        paneReflowPhases: compositor.paneReflowPhases?.size || 0,
        reflowTimers: compositor.reflowTimers?.size || 0,
        reflowMaxTimers: compositor.reflowMaxTimers?.size || 0,
        scrollOffsets: compositor.scrollOffsets?.size || 0,
        followTail: compositor.followTail?.size || 0,
        scrollLocks: compositor.scrollLocks?.size || 0,
        bufferBaseYs: compositor.bufferBaseYs?.size || 0,
        clearEvents: compositor.clearEvents?.size || 0,
        outputTimers: outputTimers?.size || 0,
        agentLogBuffers: agentLogBuffers?.size || 0,
        maxContentHeight,
        drawStats
      };
      console.log(`[metrics] ${ts} compositor=${JSON.stringify(metrics)}`);
    }, metricsIntervalMs);
  }

  // Wire up terminal manager for signal handlers
  terminal.setSession(session);
  terminal.setCompositor(compositor);

  // Create input router
  const inputRouter = new InputRouter(session, layoutManager, ipcHub, fipaHub);

  // Create register manager for yank/paste
  const registerManager = new RegisterManager();

  // Track vim state for focused agent
  const vimState = {
    mode: 'insert',  // 'insert' | 'normal' | 'visual' | 'vline'
    normalCursor: { line: 0, col: 0 },
    visualAnchor: { line: 0, col: 0 },
    visualCursor: { line: 0, col: 0 },
    awaitingRegister: false,
    selectedRegister: null
  };

  // Search state
  const searchState = {
    previousMode: 'normal',       // Mode before search started (for extending visual selection)
    active: false,
    pattern: '',
    matches: [],    // [{line, col, length}, ...]
    index: -1,
    direction: 'forward'
  };

  // Command mode state
  const commandState = {
    active: false,
    buffer: ''
  };

  // Chat mode state
  const chatState = {
    inputBuffer: '',
    cursorPos: 0,             // Cursor position within inputBuffer
    selectedAgent: null,      // Target agent for messages
    pendingPerformative: 'inform',  // Default performative
    showAgentPicker: false
  };

  // ACL send mode state (overlay-based)
  const aclState = {
    active: false,
    selectedText: '',           // From visual selection (if any)
    sourceAgent: null,          // Agent where selection was made
    targetAgent: null,          // Selected target agent
    performative: 'inform',     // Current performative
    overlayId: null,            // Reference to open overlay
    agentPickerActive: false    // Whether agent picker is showing
  };

  // Wire states to compositor for rendering
  compositor.searchState = searchState;
  compositor.visualState = vimState;
  compositor.commandState = commandState;
  compositor.chatState = chatState;          // For chat mode input
  compositor.layoutManager = layoutManager;  // For zoom indicator
  compositor.inputRouter = inputRouter;      // For mode indicator
  compositor.fipaHub = fipaHub;              // For sending messages

  // Execute search on focused agent's buffer
  function executeSearch() {
    const focusedPane = layoutManager.getFocusedPane();
    const agent = focusedPane ? session.getAgent(focusedPane.agentId) : null;
    if (!agent || !searchState.pattern) {
      searchState.matches = [];
      return;
    }

    searchState.matches = [];
    try {
      const regex = new RegExp(searchState.pattern, 'gi');
      const contentHeight = agent.getContentHeight();
      for (let i = 0; i < contentHeight; i++) {
        const line = agent.getLineText(i);
        let match;
        while ((match = regex.exec(line)) !== null) {
          searchState.matches.push({ line: i, col: match.index, length: match[0].length });
        }
      }
    } catch {
      // Invalid regex - ignore
    }

    if (searchState.matches.length > 0) {
      searchState.index = 0;
      jumpToMatch();
    }
  }

  // Jump viewport to current match
  function jumpToMatch() {
    if (searchState.matches.length === 0) return;
    const match = searchState.matches[searchState.index];
    const paneId = layoutManager.focusedPaneId;
    const pane = layoutManager.findPane(paneId);
    if (!pane) return;

    // Scroll to center match in view
    const targetScroll = Math.max(0, match.line - Math.floor(pane.bounds.height / 2));
    compositor.scrollOffsets.set(paneId, targetScroll);
  }

  // Initialize visual mode selection
  function enterVisualMode(mode, fromMode) {
    const focusedPane = layoutManager.getFocusedPane();
    const agent = focusedPane ? session.getAgent(focusedPane.agentId) : null;

    let startLine, startCol;

    if (fromMode === 'normal') {
      // Start from virtual normal cursor
      startLine = vimState.normalCursor.line;
      startCol = vimState.normalCursor.col;
    } else {
      // Start from agent's actual cursor
      if (agent && typeof agent.getBuffer === 'function') {
        const buffer = agent.getBuffer();
        if (buffer) {
          startLine = buffer.baseY + buffer.cursorY;
          startCol = buffer.cursorX;
        } else {
          startLine = 0;
          startCol = 0;
        }
      } else if (agent && typeof agent.getCursorPosition === 'function') {
        // ChatAgent uses getCursorPosition instead
        const pos = agent.getCursorPosition();
        startLine = pos.line;
        startCol = pos.col;
      } else {
        startLine = 0;
        startCol = 0;
      }
    }

    vimState.mode = mode;
    vimState.visualAnchor = { line: startLine, col: startCol };
    vimState.visualCursor = { line: startLine, col: startCol };

    // Ensure the selection start is visible
    ensureLineVisible(startLine);
  }

  // Ensure a line is visible in the viewport
  function ensureLineVisible(line) {
    const paneId = layoutManager.focusedPaneId;
    const pane = layoutManager.findPane(paneId);
    if (!pane) return;

    let scrollY = compositor.scrollOffsets.get(paneId) || 0;
    const { height } = pane.bounds;

    if (line < scrollY) {
      compositor.scrollOffsets.set(paneId, line);
    } else if (line >= scrollY + height) {
      compositor.scrollOffsets.set(paneId, line - height + 1);
    }
  }

  // Move visual cursor and keep it visible
  function moveVisualCursor(dir, count = 1) {
    const focusedPane = layoutManager.getFocusedPane();
    const agent = focusedPane ? session.getAgent(focusedPane.agentId) : null;
    if (!agent) return;

    const contentHeight = agent.getContentHeight();

    for (let i = 0; i < count; i++) {
      switch (dir) {
        case 'up':
          vimState.visualCursor.line = Math.max(0, vimState.visualCursor.line - 1);
          break;
        case 'down':
          vimState.visualCursor.line = Math.min(contentHeight - 1, vimState.visualCursor.line + 1);
          break;
        case 'left':
          if (vimState.visualCursor.col > 0) {
            vimState.visualCursor.col--;
          }
          break;
        case 'right': {
          const lineText = agent.getLineText(vimState.visualCursor.line);
          if (vimState.visualCursor.col < lineText.length - 1) {
            vimState.visualCursor.col++;
          }
          break;
        }
      }
    }

    ensureLineVisible(vimState.visualCursor.line);
  }

  // Yank selection to register
  function yankSelection(targetRegister = null) {
    const focusedPane = layoutManager.getFocusedPane();
    const agent = focusedPane ? session.getAgent(focusedPane.agentId) : null;
    if (!agent) return;

    const text = extractSelectedText(agent, vimState);
    if (!text) return;

    const type = vimState.mode === 'vline' ? 'line' : 'char';
    const reg = targetRegister?.toLowerCase() || null;
    const append = targetRegister && /[A-Z]/.test(targetRegister);

    if (reg === '+' || reg === '*') {
      // System clipboard
      registerManager.setClipboard(text);
    } else {
      // Per-agent register
      registerManager.yank(agent.id, text, type, reg, append);
      // Also sync to system clipboard (unless specific register requested)
      if (!targetRegister) {
        const b64 = Buffer.from(text).toString('base64');
        process.stdout.write(`\x1b]52;c;${b64}\x07`);
      }
    }

    // Return to normal mode
    vimState.mode = 'normal';
  }

  // Paste from register
  function pasteFromRegister(after = true, registerName = null) {
    const focusedPane = layoutManager.getFocusedPane();
    const agent = focusedPane ? session.getAgent(focusedPane.agentId) : null;
    if (!agent || !agent.pty) return;

    const reg = registerName?.toLowerCase() || '"';
    let entry;

    if (reg === '+' || reg === '*') {
      entry = registerManager.clipboard;
    } else {
      entry = registerManager.get(agent.id, reg);
    }

    if (!entry || !entry.content) return;

    // Write content to agent's PTY
    agent.write(entry.content);
  }

  // Debounce timer for terminal resize (prevents flooding agents with SIGWINCH)
  let terminalResizeTimer = null;

  // Smart reflow detection - wait for output to stabilize instead of fixed timeout
  let reflowSilenceTimer = null;
  let reflowMaxTimer = null;
  const REFLOW_SILENCE_MS = 20;   // Consider reflow complete after 20ms of no output
  const REFLOW_MAX_MS = 100;      // Max wait in case agent produces no output
  let outputSilenceMs = parseInt(process.env.BUKOWSKI_OUTPUT_SILENCE_DURATION, 10) || 16;
  const outputTimers = new Map(); // per-agent debounce timers

  function onReflowComplete() {
    if (compositor.resizePhase !== 'reflowing') return;

    clearTimeout(reflowSilenceTimer);
    clearTimeout(reflowMaxTimer);
    reflowSilenceTimer = null;
    reflowMaxTimer = null;

    compositor.restoreScrollPositions();
    compositor.clearFrameCache();  // Also sets resizePhase = 'idle'
    compositor.draw();
  }

  function onAgentOutputDuringReflow() {
    if (compositor.resizePhase !== 'reflowing') return;
    // Reset silence timer - agent is still producing output
    clearTimeout(reflowSilenceTimer);
    reflowSilenceTimer = setTimeout(onReflowComplete, REFLOW_SILENCE_MS);
  }

  // Handle terminal resize
  function handleResize() {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;

    // At START of resize sequence: capture current frames AND scroll positions
    // This is TRUE double-buffering - we show cached frames during resize
    if (compositor.resizePhase === 'idle') {
      compositor.captureFrames();       // Snapshot current display (sets phase='cached')
      compositor.cacheScrollPositions(); // Remember scroll state
    }

    // Update bounds and draw from CACHED frames (cropped/padded)
    // NOT reading from xterm.js - avoids ugly-wrap artifacts
    compositor.updateBounds(cols, rows);
    compositor.draw();  // Uses frameCache, not live xterm content

    // Debounce actual terminal resize (SIGWINCH to agents)
    // This prevents Claude from redrawing dozens of times during mousewheel resize
    clearTimeout(terminalResizeTimer);
    terminalResizeTimer = setTimeout(() => {
      terminalResizeTimer = null;

      // Transition to 'reflowing' phase - skip draws during SIGWINCH processing
      compositor.startReflowing();

      // Now resize all terminals (triggers reflow + SIGWINCH)
      for (const pane of layoutManager.getAllPanes()) {
        const agent = session.getAgent(pane.agentId);
        if (agent && agent.pty) {
          agent.resize(pane.bounds.width, pane.bounds.height);
        } else if (agent && agent.type === 'chat') {
          // ChatAgent has no PTY but needs resize for text reflow
          agent.resize(pane.bounds.width, pane.bounds.height);
        }
      }

      // Smart reflow detection: wait for agent output to stabilize
      // Max timeout fallback (in case agent produces no output)
      reflowMaxTimer = setTimeout(onReflowComplete, REFLOW_MAX_MS);
      // Start silence timer (will be reset by agent output)
      reflowSilenceTimer = setTimeout(onReflowComplete, REFLOW_SILENCE_MS);
    }, 100);  // Wait 100ms after last resize event
  }

  // Execute ex-command
  // Capture agent session IDs from filesystem before saving
  // Always refresh by finding most recently modified session for each agent's cwd
  // This handles cases where user runs /resume inside an agent to switch sessions
  async function captureAgentSessions() {
    const cwd = process.cwd();
    const assignedIds = new Set();

    // Sort agents by spawnedAt so earlier agents get first pick
    const agents = session.getAllAgents().sort((a, b) => (a.spawnedAt || 0) - (b.spawnedAt || 0));

    for (const agent of agents) {
      // PTY-scraped IDs (from "claude --resume <UUID>" printed at exit) are authoritative
      if (agent.sessionIdCaptured && agent.agentSessionId) {
        assignedIds.add(agent.agentSessionId);
        continue;
      }

      if (!agent.spawnedAt) {
        // Agent never spawned, preserve existing ID if any
        if (agent.agentSessionId) {
          assignedIds.add(agent.agentSessionId);
        }
        continue;
      }

      try {
        // Fall back to filesystem mtime when no PTY scrape is available
        const sessionId = await findLatestSession(agent.type, cwd, agent.spawnedAt, assignedIds);
        if (sessionId) {
          agent.agentSessionId = sessionId;
          assignedIds.add(sessionId);
        } else if (agent.agentSessionId) {
          // No new session found, preserve existing
          assignedIds.add(agent.agentSessionId);
        }
      } catch {
        // On error, preserve existing ID if any
        if (agent.agentSessionId) {
          assignedIds.add(agent.agentSessionId);
        }
      }
    }
  }

  // Command execution delegated to CommandExecutor (initialized after dispatcher)
  let commandExecutor = null;
  function executeCommand(cmd) {
    if (commandExecutor) {
      commandExecutor.execute(cmd);
    }
  }

  // Initial setup
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  compositor.resize(cols, rows);

  // Spawn agents for all panes
  // For restored sessions, inject resume args so agents continue their conversations
  // For new sessions, spawn the initial agent fresh
  const allPanes = layoutManager.getAllPanes();
  for (let i = 0; i < allPanes.length; i++) {
    const pane = allPanes[i];
    const agent = session.getAgent(pane.agentId);
    // Skip chat agents (virtual, no PTY/spawn) and already-spawned agents
    if (agent && !agent.pty && agent.type !== 'chat') {
      // On fresh sessions, drop any stale saved agentSessionId to avoid reusing old resumes
      if (!restoredSession) {
        agent.agentSessionId = null;
      }

      // If restoring a session, rebuild command+args from AGENT_TYPES + resume args
      // Don't use saved agent.args/command - they may contain old resume args or a
      // stale command (e.g. 'node' from a prior install with a local entrypoint)
      // Also inject FIPA reminder prompt
      if (restoredSession) {
        const typeConfig = AGENT_TYPES[agent.type];
        if (typeConfig) {
          const baseArgs = typeConfig.args || [];
          // Validate session ID is a proper UUID before using it
          const sessionId = agent.agentSessionId;
          const isValidUuid = sessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId);
          const resumeArgs = typeConfig.getResumeArgs?.(isValidUuid ? sessionId : null) || [];
          const combinedArgs = [...baseArgs, ...resumeArgs];
          const fipaArgs = getFIPAPromptArgs(AGENT_TYPES, agent.type, combinedArgs);
          agent.command = typeConfig.command;
          agent.args = [...combinedArgs, ...fipaArgs];
        }
      }

      // For the first pane, use half width trick for Claude banner
      if (i === 0 && agent.type === 'claude') {
        const initialWidth = Math.floor(pane.bounds.width / 2);
        agent.spawn(initialWidth, pane.bounds.height);
        // Resize to actual size after banner renders
        setTimeout(() => {
          agent.resize(pane.bounds.width, pane.bounds.height);
        }, 100);
      } else {
        agent.spawn(pane.bounds.width, pane.bounds.height);
      }
    }
  }

  // Enter raw mode
  process.stdin.setRawMode(true);
  process.stdin.resume();

  // Mouse mode
  process.stdout.write('\x1b[?1000h\x1b[?1006h');

  // Resize handler
  process.stdout.on('resize', handleResize);

  // Create new agent (for splits)
  // Set up handlers for an agent's PTY (data + exit)
  function setupAgentHandlers(agent) {
    if (!agent.pty) return;

    // Coalesce PTY output to avoid mid-update flicker on wrapped content.
    agent.pty.onData((data) => {
      logAgentData(agent.id, data);
      if (compositor.resizePhase === 'reflowing') {
        onAgentOutputDuringReflow();  // Smart reflow detection
        return;
      }

      const pane = layoutManager.findPaneByAgent(agent.id);
      if (pane) {
        // Detect full refresh sequences - these indicate major redraw
        // \x1b[2J = clear screen, \x1b[H\x1b[J = cursor home + clear below
        if (data.includes('\x1b[2J') || data.includes('\x1b[H\x1b[J')) {
          compositor.enterOutputReflow(pane.id);
          compositor.recordClear(pane.id);
        }

        // Check for output reflow (large buffer churn near scrollback limit)
        compositor.checkOutputReflow(pane.id, agent);

        // Skip regular scheduling if this pane just entered output reflow
        if (compositor.paneReflowPhases.get(pane.id) === 'reflowing') {
          return;
        }
      }

      // Per-agent debounce timer
      const existing = outputTimers.get(agent.id);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        outputTimers.delete(agent.id);
        compositor.scheduleDraw();
      }, outputSilenceMs);
      outputTimers.set(agent.id, timer);
    });

    agent.pty.onExit(({ exitCode }) => handleAgentExit(agent, exitCode));
  }

  function createNewAgent(type = 'claude', extraArgs = []) {
    const config = AGENT_TYPES[type];
    if (!config || !config.command) {
      // Fallback to claude if type not available
      type = 'claude';
    }
    const agentConfig = AGENT_TYPES[type];

    // Find next available ID (don't just use count - there may be gaps)
    const existingAgents = session.getAllAgents().filter(a => a.type === type);
    const existingIds = new Set(existingAgents.map(a => a.id));
    let nextNum = 1;
    while (existingIds.has(`${type}-${nextNum}`)) {
      nextNum++;
    }
    const newId = `${type}-${nextNum}`;

    // Combine base args with any extra CLI args (e.g., --continue)
    // Inject FIPA reminder if user didn't provide their own prompt
    const baseArgs = [...agentConfig.args, ...extraArgs];
    const fipaArgs = getFIPAPromptArgs(AGENT_TYPES, type, baseArgs);
    const fullArgs = [...baseArgs, ...fipaArgs];

    const newAgent = new Agent({
      id: newId,
      name: agentConfig.name,
      type,
      command: agentConfig.command,
      args: fullArgs,
      autostart: true
    });

    session.addAgent(newAgent);

    // Announce new agent in chat
    broadcastSystemMessage(`${newAgent.name} (${newAgent.id}) joined the session`);

    return newAgent;
  }

  // Pending chat split direction (set when conversation picker is shown)
  let pendingChatSplit = null;

  // Create a ChatAgent for a conversation and add it to a pane
  function createChatPane(conversationId, splitDir = 'horizontal') {
    // Create ChatAgent
    const chatAgent = new ChatAgent(conversationId, fipaHub.conversations, fipaHub);
    chatAgent.setAvailableAgents(session.getAllAgents().filter(a => a.type !== 'chat'));

    // Add to session
    session.addAgent(chatAgent);
    flushPendingChatErrors();

    // Create pane
    let newPane;
    if (splitDir === 'horizontal') {
      newPane = layoutManager.splitHorizontal(chatAgent.id);
    } else {
      newPane = layoutManager.splitVertical(chatAgent.id);
    }

    if (newPane) {
      chatAgent.resize(newPane.bounds.width, newPane.bounds.height);

      // Listen for chat agent output
      chatAgent.on('data', () => compositor.scheduleDraw());
    }

    handleResize();
    return chatAgent;
  }

  // Show conversation picker overlay
  function showConversationPicker(splitDir = 'horizontal') {
    pendingChatSplit = splitDir;

    const conversations = ConversationPicker.getConversationList(fipaHub.conversations);
    const agents = session.getAllAgents().filter(a => a.type !== 'chat');

    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const overlayWidth = Math.min(50, cols - 4);
    const overlayHeight = Math.min(conversations.length + 4, 15);

    overlayManager.show({
      id: 'conversation-picker',
      type: 'conversation-picker',
      x: Math.floor((cols - overlayWidth) / 2),
      y: Math.floor((rows - overlayHeight) / 2),
      width: overlayWidth,
      height: overlayHeight,
      title: 'Select Conversation',
      conversations,
      conversationManager: fipaHub.conversations,
      agents
    });

    compositor.draw();
  }

  // Focus or create chat pane (for Ctrl+Space c)
  function focusOrCreateChatPane() {
    // Ensure we're not in legacy chat mode (pane-based now)
    if (inputRouter.getMode() === 'chat') {
      inputRouter.setMode('insert');
    }

    // Find existing chat panes
    const chatPanes = layoutManager.getAllPanes().filter(p => p.agentId.startsWith('chat-'));

    if (chatPanes.length > 0) {
      // Focus the most recent chat pane
      layoutManager.focusPane(chatPanes[chatPanes.length - 1].id);
      compositor.draw();
    } else {
      // No chat panes - show conversation picker to create one
      showConversationPicker('horizontal');
    }
  }

  // Handle input actions from InputRouter
  // NOTE: All handlers have been extracted to src/handlers/*
  // This function is kept as a fallback for any unextracted actions
  function handleAction(result) {
    // All handlers extracted to:
    // - layout: focus_direction, focus_next, focus_prev, focus_chat, split_*, close_*, new_tab, etc.
    // - vim: cursor_*, scroll_*, word_*, find_char, goto_*, jump_*
    // - search: search_*, command_*
    // - session: save_session, quit_*, passthrough
    // - visual: mode_change, extend_*, visual_cancel
    // - yank: yank_*, delete_*, paste, await_register, register_selected
    // - fipa: fipa_*
    // - chat: chat_*
    // - acl: acl_*
    //
    // If you see this message, an action slipped through:
    // console.log('Unhandled action:', result.action);
  }

  // Set up action dispatcher (compatibility layer - forwards to handleAction)
  const dispatcher = new ActionDispatcher();
  dispatcher.setContext({
    session,
    layoutManager,
    compositor,
    inputRouter,
    registerManager,
    fipaHub,
    overlayManager,
    terminal,
    vimState,
    searchState,
    commandState,
    chatState,
    aclState,
    AGENT_TYPES,
    onHandleResize: handleResize,
    onHandleAction: handleAction,
    onExecuteCommand: executeCommand,
    onCreateNewAgent: createNewAgent,
    onSetupAgentHandlers: setupAgentHandlers,
    onCreateChatPane: createChatPane,
    onShowConversationPicker: showConversationPicker,
    onFocusOrCreateChatPane: focusOrCreateChatPane,
    onYankSelection: yankSelection,
    onEnterVisualMode: enterVisualMode,
    onMoveVisualCursor: moveVisualCursor,
    onExecuteSearch: executeSearch,
    onJumpToMatch: jumpToMatch,
    onPasteFromRegister: pasteFromRegister,
    chatPane,
    ipcHub
  });
  dispatcher.setFallbackHandler(handleAction);

  // Initialize CommandExecutor (needs dispatcher for action dispatch)
  commandExecutor = new CommandExecutor({
    layoutManager,
    terminal,
    session,
    ipcHub,
    fipaHub,
    dispatcher,
    AGENT_TYPES,
    resolveAgentType,
    onCaptureAgentSessions: captureAgentSessions,
    onSetOutputSilence: (ms) => { outputSilenceMs = ms; },
    onSetEchoTimeout: (ms) => { fipaEchoTimeoutMs = ms; },
    onShowStatusMessage: (msg, timeout) => compositor.showStatusMessage(msg, timeout)
  });

  // Input handling
  let chatEscBuffer = '';
  let chatEscTimer = null;
  process.stdin.on('data', (data) => {
    let str = data.toString();

    // In chat mode, buffer lone ESC to allow split escape sequences (e.g. Ctrl+Arrow).
    const focusedPane = layoutManager.getFocusedPane();
    const focusedAgent = focusedPane ? session.getAgent(focusedPane.agentId) : null;
    const chatFocused = focusedAgent?.type === 'chat';
    if (chatFocused) {
      if (chatEscBuffer) {
        str = chatEscBuffer + str;
        chatEscBuffer = '';
      }

      if (str.startsWith('\x1b[200~')) {
        if (!str.includes('\x1b[201~')) {
          chatEscBuffer = str;
          return;
        }
      } else if (str.startsWith('\x1b') && !/[A-Za-z~]$/.test(str)) {
        chatEscBuffer = str;
        if (str === '\x1b') {
          if (chatEscTimer) clearTimeout(chatEscTimer);
          chatEscTimer = setTimeout(() => {
            const buffered = chatEscBuffer;
            chatEscBuffer = '';
            chatEscTimer = null;
            const result = inputRouter.handle(buffered);
            dispatcher.dispatch(result);
          }, 25);
        }
        return;
      }
    }

    // Mouse handling (SGR)
    // SGR button encoding:
    //   bits 0-1: button (0=left, 1=middle, 2=right)
    //   bit 2: shift
    //   bit 3: meta/alt
    //   bit 4: ctrl
    //   64/65: scroll up/down
    const mouseMatch = str.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (mouseMatch) {
      const btn = parseInt(mouseMatch[1]);
      const mx = parseInt(mouseMatch[2]) - 1;  // 1-indexed to 0-indexed
      const my = parseInt(mouseMatch[3]) - 1;

      // Extract modifiers and base button
      const isShift = (btn & 4) !== 0;
      const isMeta = (btn & 8) !== 0;  // Alt/Meta key
      const isCtrl = (btn & 16) !== 0;
      const baseBtn = btn & ~(4 | 8 | 16); // Remove modifier bits

      if (mouseMatch[4] === 'M') {
        // Left click (btn 0) - focus pane under mouse or tab bar click
        if (baseBtn === 0 && !isShift && !isCtrl && !isMeta) {
          if (my === 0) {
            // Tab bar click - map x position to agent tab
            const tabIndex = tabBar.getTabAtPosition(mx, compositor.cols);
            if (tabIndex !== -1) {
              const agents = session.getAllAgents();
              if (tabIndex < agents.length) {
                layoutManager.focusByAgent(agents[tabIndex].id);
                handleResize();
              }
            }
          } else {
            const pane = layoutManager.findPaneAt(mx, my);
            if (pane && pane.id !== layoutManager.focusedPaneId) {
              layoutManager.focusPane(pane.id);
            }
          }
        }
        // Ctrl+scroll wheel - vertical pane resize (adjust horizontal splits)
        else if (isCtrl && (baseBtn === 64 || baseBtn === 65)) {
          const delta = baseBtn === 64 ? 1 : -1;
          if (layoutManager.resizeAtPosition(mx, my, 'vertical', delta)) {
            handleResize();
          }
        }
        // Shift or Alt+scroll wheel - horizontal pane resize (adjust vertical splits)
        else if ((isShift || isMeta) && (baseBtn === 64 || baseBtn === 65)) {
          const delta = baseBtn === 64 ? 1 : -1;
          if (layoutManager.resizeAtPosition(mx, my, 'horizontal', delta)) {
            handleResize();
          }
        }
        // Plain scroll wheel - scroll pane under mouse
        else if (baseBtn === 64 || baseBtn === 65) {
          const pane = layoutManager.findPaneAt(mx, my);
          if (pane) {
            const delta = baseBtn === 64 ? -3 : 3;
            compositor.scrollPane(pane.id, delta);
          }
        }
      }
      return;
    }

    // Handle overlay input first (if overlay is active)
    if (overlayManager.hasActiveOverlay()) {
      const overlay = overlayManager.getFocused();
      if (overlay && typeof overlay.handleInput === 'function') {
        const result = overlay.handleInput(str);

        if (result.action === 'conversation_new') {
          // Start new conversation - create new one and open chat pane
          overlayManager.hide(overlay.id);
          const conversation = fipaHub.conversations.createConversation?.();
          const conversationId = conversation?.id || Date.now().toString();
          createChatPane(conversationId, pendingChatSplit || 'horizontal');
          pendingChatSplit = null;
          compositor.draw();
          return;
        }

        if (result.action === 'conversation_select') {
          // Select existing conversation
          overlayManager.hide(overlay.id);
          createChatPane(result.conversationId, pendingChatSplit || 'horizontal');
          pendingChatSplit = null;
          compositor.draw();
          return;
        }

        if (result.action === 'picker_cancel') {
          overlayManager.hide(overlay.id);
          pendingChatSplit = null;
          compositor.draw();
          return;
        }

        if (result.action === 'picker_move') {
          compositor.draw();
          return;
        }

        // Other overlay actions just redraw
        compositor.draw();
        return;
      }
    }

    // Route input through dispatcher
    const result = inputRouter.handle(str);
    dispatcher.dispatch(result);
  });

  // Render on agent output - use scheduleDraw for throttled drawing (like index.js)
  for (const agent of session.getAllAgents()) {
    if (agent.pty) {
      agent.pty.onData((data) => {
        logAgentData(agent.id, data);
        onAgentOutputDuringReflow();  // Smart reflow detection

        const pane = layoutManager.findPaneByAgent(agent.id);
        if (pane) {
          // Detect full refresh sequences
          if (data.includes('\x1b[2J') || data.includes('\x1b[H\x1b[J')) {
            compositor.enterOutputReflow(pane.id);
            compositor.recordClear(pane.id);
          }
          compositor.checkOutputReflow(pane.id, agent);
        }

        compositor.scheduleDraw();
      });
      agent.pty.onExit(({ exitCode }) => handleAgentExit(agent, exitCode));
    }
  }

  // Initial render (immediate)
  compositor.draw();

  // Periodic refresh for cursor blink / idle updates
  // Skip when overlay is active to prevent flicker
  setInterval(() => {
    if (!overlayManager.hasActiveOverlay()) {
      compositor.scheduleDraw();
    }
  }, 100);

  // Register shutdown callbacks for SIGINT/SIGTERM
  terminal.onShutdown(() => {
    if (metricsTimer) clearInterval(metricsTimer);
    if (mcpServer) mcpServer.stop();
    if (ipcHub) ipcHub.stop();
    if (fipaHub) fipaHub.shutdown();
    session.destroy();
  });

  // Handle agent exit for initial agents (onData already set up above)
  for (const agent of session.getAllAgents()) {
    if (agent.pty) {
      agent.pty.onExit(({ exitCode }) => handleAgentExit(agent, exitCode));
    }
  }

})();
