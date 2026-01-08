#!/usr/bin/env node
// bukowski multi-agent terminal - v1.1

const path = require('path');
const fs = require('fs');

// Bootstrap module
const {
  SOCKET_DISCOVERY_FILE,
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
const { ActionDispatcher } = require('./src/handlers');

// Initialize agent types with discovered CLI paths
const claudePath = findClaudePath();
const codexPath = findCodexPath();
const AGENT_TYPES = createAgentTypes(claudePath, codexPath);

// Load quotes for splash screen
const quotesPath = path.join(__dirname, 'quotes.txt');
const QUOTES = loadQuotes(quotesPath);

const cliArgs = parseArgs();

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
const terminal = new TerminalManager(SOCKET_DISCOVERY_FILE);
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
    const initialArgs = [claudePath, ...cliArgs.agentArgs];
    const fipaArgs = getFIPAPromptArgs(AGENT_TYPES, 'claude', initialArgs);
    const claude = new Agent({
      id: 'claude-1',
      name: 'Claude',
      type: 'claude',
      command: 'node',
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
          }
        }
      }
    }
  } catch (err) {
    console.error('Warning: FIPA hub failed to initialize:', err.message);
  }

  // Start MCP Server for agent tool communication
  const mcpServer = new MCPServer(session, fipaHub, ipcHub);
  try {
    const socketPath = await mcpServer.start();

    // Set socket path in process.env so spawned agents inherit it
    // This ensures agents connect to THIS instance's MCP server, not another instance's
    process.env.BUKOWSKI_MCP_SOCKET = socketPath;

    // Wire FIPAHub messages to MCP message queue and PTY injection
    fipaHub.on('fipa:sent', ({ message, to }) => {
      if (!to) return;

      // Queue for MCP polling
      mcpServer.queueMessage(to, message);

      // For session agents with PTY, inject and auto-submit to trigger response
      const agent = session.getAgent(to);
      if (agent?.pty && message.sender?.name !== to) {
        const prompt = formatFIPAForPTY(message);
        // Small delay to not interrupt mid-output
        setTimeout(() => {
          agent.pty.write(prompt);
          // Send \r separately after a tiny delay to trigger submit
          setTimeout(() => {
            agent.pty.write('\r');
          }, 50);
        }, 100);
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
      const content = typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content, null, 2);

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

    // Write socket path to discovery file for MCP bridge (fallback for external tools)
    try {
      fs.writeFileSync(SOCKET_DISCOVERY_FILE, socketPath, 'utf-8');
    } catch {
      // Ignore - discovery file is optional
    }
  } catch (err) {
    console.error('Warning: MCP server failed to start:', err.message);
  }

  // Create FIPA UI components
  const conversationList = new ConversationList(fipaHub.conversations);
  const chatPane = new ChatPane(fipaHub.conversations);

  // Create overlay manager for modal UIs (ACL input, agent picker, etc.)
  const overlayManager = new OverlayManager();

  // Create compositor
  const compositor = new Compositor(session, layoutManager, tabBar, chatPane, conversationList, overlayManager);
  compositor.startCursorBlink();

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
  const outputTimers = new Map();

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
      if (!agent.spawnedAt) {
        // Agent never spawned, preserve existing ID if any
        if (agent.agentSessionId) {
          assignedIds.add(agent.agentSessionId);
        }
        continue;
      }

      try {
        // Always look for most recently modified session (handles /resume switches)
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

  function executeCommand(cmd) {
    const parts = cmd.trim().split(/\s+/);
    const command = parts[0];
    const args = parts.slice(1);

    switch (command) {
      case 'q':
      case 'quit':
        // Close focused pane, or quit if last pane
        const panes = layoutManager.getAllPanes();
        if (panes.length === 1) {
          terminal.cleanup();
          if (ipcHub) ipcHub.stop();
          session.destroy();
          process.exit(0);
        } else {
          handleAction({ action: 'close_pane' });
        }
        break;

      case 'q!':
      case 'quit!':
      case 'qa':
      case 'qa!':
      case 'qall':
      case 'qall!':
        // Force quit everything
        terminal.cleanup();
        if (ipcHub) ipcHub.stop();
        session.destroy();
        process.exit(0);
        break;

      case 'e':
      case 'edit': {
        // :e [agent] [extra-args...] - new tab with agent (default: claude)
        const agentType = resolveAgentType(AGENT_TYPES, args[0]);
        if (agentType) {
          const extraArgs = args.slice(1);  // Additional CLI args like --continue
          handleAction({ action: 'new_tab', agentType, extraArgs });
        }
        break;
      }

      case 'sp':
      case 'split': {
        // :sp [agent] [extra-args...] - horizontal split (default: claude)
        const agentType = resolveAgentType(AGENT_TYPES, args[0]);
        if (agentType) {
          const extraArgs = args.slice(1);
          handleAction({ action: 'split_horizontal', agentType, extraArgs });
        }
        break;
      }

      case 'vs':
      case 'vsp':
      case 'vsplit': {
        // :vs [agent] [extra-args...] - vertical split (default: claude)
        const agentType = resolveAgentType(AGENT_TYPES, args[0]);
        if (agentType) {
          const extraArgs = args.slice(1);
          handleAction({ action: 'split_vertical', agentType, extraArgs });
        }
        break;
      }

      case 'set': {
        // :set key=value (runtime tuning)
        if (!args.length) break;
        const assignment = args.join(' ');
        let key;
        let value;
        if (assignment.includes('=')) {
          const parts = assignment.split('=');
          key = parts[0];
          value = parts.slice(1).join('=');
        } else {
          key = args[0];
          value = args[1];
        }

        key = (key || '').trim().toLowerCase();
        value = (value || '').trim();
        if (!key || !value) break;

        if (['output_silence', 'output_silence_ms', 'output-silence', 'output_silence_duration'].includes(key)) {
          const ms = Math.max(0, parseInt(value, 10));
          if (!Number.isNaN(ms)) {
            outputSilenceMs = ms;
            process.env.BUKOWSKI_OUTPUT_SILENCE_DURATION = String(ms);
          }
        } else if (key === 'scrollback') {
          const sb = Math.max(0, parseInt(value, 10));
          if (!Number.isNaN(sb)) {
            process.env.BUKOWSKI_SCROLLBACK = String(sb);
          }
        }
        break;
      }

      case 'only':
      case 'on':
        handleAction({ action: 'close_others' });
        break;

      case 'close':
      case 'clo':
        handleAction({ action: 'close_pane' });
        break;

      case 'w':
      case 'write':
      case 'save': {
        // :w [name] - save session (optionally rename)
        if (args[0]) {
          session.name = args[0];
        }
        // Sync focused pane ID to session before saving
        session.focusedPaneId = layoutManager.focusedPaneId;
        // If zoomed, save the unzoomed layout (so restore gets full layout)
        const wasZoomed = layoutManager.isZoomed();
        const zoomedLayout = wasZoomed ? session.layout : null;
        if (wasZoomed) {
          session.layout = layoutManager.savedLayout;
        }
        // Capture agent session IDs before saving
        captureAgentSessions().then(() => {
          return session.save(undefined, fipaHub.conversations);
        }).then(filepath => {
          // Restore zoomed state after save
          if (wasZoomed) {
            session.layout = zoomedLayout;
          }
        }).catch(() => {
          // Restore zoomed state on error too
          if (wasZoomed) {
            session.layout = zoomedLayout;
          }
        });
        break;
      }

      case 'wq':
      case 'x': {
        // :wq / :x - save and quit
        if (args[0]) session.name = args[0];
        session.focusedPaneId = layoutManager.focusedPaneId;
        // If zoomed, save the unzoomed layout
        if (layoutManager.isZoomed()) {
          session.layout = layoutManager.savedLayout;
        }
        // Capture agent session IDs before saving
        captureAgentSessions().then(() => {
          return session.save(undefined, fipaHub.conversations);
        }).then(() => {
          terminal.cleanup();
          if (ipcHub) ipcHub.stop();
          session.destroy();
          process.exit(0);
        }).catch(() => {
          terminal.cleanup();
          if (ipcHub) ipcHub.stop();
          session.destroy();
          process.exit(1);
        });
        break;
      }

      case 'sessions':
      case 'ls': {
        // :sessions - list saved sessions (writes to focused agent as info)
        Session.listSessions().then(sessions => {
          if (sessions.length === 0) {
            // No sessions saved yet
            return;
          }
          // Format session list
          let output = '\r\n--- Saved Sessions ---\r\n';
          for (const s of sessions.slice(0, 10)) {
            const date = new Date(s.updatedAt).toLocaleString();
            output += `  ${s.name} (${s.id.slice(0, 8)}) - ${s.agentCount} agents - ${date}\r\n`;
          }
          output += '----------------------\r\n';
          // Write to focused agent's terminal
          const focusedAgent = layoutManager.getFocusedAgent();
          if (focusedAgent?.terminal) {
            focusedAgent.terminal.write(output);
          }
        });
        break;
      }

      case 'restore':
      case 'load': {
        // :restore [name|id] - restore a session (not implemented in-place, show hint)
        const target = args[0] || 'latest';
        const focusedAgent = layoutManager.getFocusedAgent();
        if (focusedAgent?.terminal) {
          focusedAgent.terminal.write(`\r\nTo restore session "${target}", restart with: bukowski --restore ${target}\r\n`);
        }
        break;
      }

      case 'name':
      case 'rename': {
        // :name <newname> - rename current session
        if (args[0]) {
          session.name = args[0];
        }
        break;
      }

      default:
        // Unknown command - silently ignore for now
        break;
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
      // If restoring a session, rebuild args from AGENT_TYPES + resume args
      // Don't use saved agent.args - they may contain old resume args
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
        }

        // Check for output reflow (large buffer churn near scrollback limit)
        compositor.checkOutputReflow(pane.id, agent);

        // Skip regular scheduling if this pane just entered output reflow
        if (compositor.paneReflowPhases.get(pane.id) === 'reflowing') {
          return;
        }
      }

      const existing = outputTimers.get(agent.id);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        outputTimers.delete(agent.id);
        compositor.scheduleDraw();
      }, outputSilenceMs);
      outputTimers.set(agent.id, timer);
    });

    agent.pty.onExit(({ exitCode }) => {
      if (exitCode !== 0) {
        // Keep the pane open on errors so the user can see the failure.
        const msg = `\r\n\x1b[31m[process exited with code ${exitCode}]\x1b[0m\r\n`;
        agent.terminal?.write(msg);
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
          session.removeAgent(agent.id);
          handleResize();
        }
      }
    });
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
  function handleAction(result) {
    const focusedPane = layoutManager.getFocusedPane();
    const focusedAgent = focusedPane ? session.getAgent(focusedPane.agentId) : null;

    switch (result.action) {
      // Mode changes
      case 'mode_change':
        if (result.mode === 'normal' && focusedAgent) {
          // Initialize normal cursor to agent's cursor position
          const buffer = focusedAgent.getBuffer?.();
          if (buffer) {
            vimState.normalCursor.line = buffer.baseY + buffer.cursorY;
            vimState.normalCursor.col = buffer.cursorX;
          }
          vimState.mode = 'normal';
        } else if (result.mode === 'insert') {
          vimState.mode = 'insert';
        } else if (result.mode === 'visual') {
          // Enter visual char mode, context-aware start position
          const prevMode = vimState.mode;
          enterVisualMode('visual', prevMode);
        } else if (result.mode === 'visual-line') {
          // Enter visual line mode
          const prevMode = vimState.mode;
          enterVisualMode('vline', prevMode);
        }
        break;

      // focus_chat -> extracted to handlers/layout

      // Visual mode actions
      case 'extend_selection':
        if (vimState.mode === 'visual' || vimState.mode === 'vline') {
          moveVisualCursor(result.dir, result.count || 1);
        }
        break;

      case 'extend_half_page': {
        if (vimState.mode === 'visual' || vimState.mode === 'vline') {
          const halfPage = Math.floor((focusedPane?.bounds.height || 12) / 2);
          moveVisualCursor(result.dir, halfPage);
        }
        break;
      }

      case 'extend_to_top':
        if (vimState.mode === 'visual' || vimState.mode === 'vline') {
          vimState.visualCursor.line = 0;
          if (vimState.mode === 'visual') {
            vimState.visualCursor.col = 0;
          }
          ensureLineVisible(0);
        }
        break;

      case 'extend_to_bottom':
        if ((vimState.mode === 'visual' || vimState.mode === 'vline') && focusedAgent) {
          const lastLine = focusedAgent.getContentHeight() - 1;
          vimState.visualCursor.line = Math.max(0, lastLine);
          if (vimState.mode === 'visual') {
            const lineText = focusedAgent.getLineText(lastLine);
            vimState.visualCursor.col = Math.max(0, lineText.length - 1);
          }
          ensureLineVisible(vimState.visualCursor.line);
        }
        break;

      // Visual mode line position
      case 'extend_line_start':
        if (vimState.mode === 'visual') {
          vimState.visualCursor.col = 0;
        }
        break;

      case 'extend_line_end':
        if (vimState.mode === 'visual' && focusedAgent) {
          const lineText = focusedAgent.getLineText(vimState.visualCursor.line) || '';
          vimState.visualCursor.col = Math.max(0, lineText.length - 1);
        }
        break;

      case 'extend_first_nonblank':
        if (vimState.mode === 'visual' && focusedAgent) {
          const lineText = focusedAgent.getLineText(vimState.visualCursor.line) || '';
          const match = lineText.match(/^\s*/);
          vimState.visualCursor.col = match ? match[0].length : 0;
        }
        break;

      // Visual mode word movements
      case 'extend_word_forward':
        if ((vimState.mode === 'visual' || vimState.mode === 'vline') && focusedAgent) {
          for (let i = 0; i < (result.count || 1); i++) {
            moveWordForward(focusedAgent, vimState.visualCursor, result.bigWord);
          }
          ensureLineVisible(vimState.visualCursor.line);
        }
        break;

      case 'extend_word_end':
        if ((vimState.mode === 'visual' || vimState.mode === 'vline') && focusedAgent) {
          for (let i = 0; i < (result.count || 1); i++) {
            moveWordEnd(focusedAgent, vimState.visualCursor, result.bigWord);
          }
          ensureLineVisible(vimState.visualCursor.line);
        }
        break;

      case 'extend_word_backward':
        if ((vimState.mode === 'visual' || vimState.mode === 'vline') && focusedAgent) {
          for (let i = 0; i < (result.count || 1); i++) {
            moveWordBackward(focusedAgent, vimState.visualCursor, result.bigWord);
          }
          ensureLineVisible(vimState.visualCursor.line);
        }
        break;

      case 'yank_selection':
        yankSelection(result.register);
        break;

      case 'delete_selection':
        // First yank to register, then we would delete (but in a read-only terminal, just yank)
        yankSelection(result.register);
        break;

      case 'yank_lines': {
        if (!focusedAgent) break;
        const text = extractLines(focusedAgent, vimState.normalCursor.line, result.count || 1);
        const reg = result.register?.toLowerCase();
        const append = result.register && /[A-Z]/.test(result.register);
        if (reg === '+' || reg === '*') {
          registerManager.setClipboard(text);
        } else {
          registerManager.yank(focusedAgent.id, text, 'line', reg, append);
          // Sync to clipboard if no specific register
          if (!result.register) {
            const b64 = Buffer.from(text).toString('base64');
            process.stdout.write(`\x1b]52;c;${b64}\x07`);
          }
        }
        break;
      }

      case 'yank_word': {
        if (!focusedAgent) break;
        const { text } = extractWord(focusedAgent, vimState.normalCursor.line, vimState.normalCursor.col);
        if (!text) break;
        const reg = result.register?.toLowerCase();
        const append = result.register && /[A-Z]/.test(result.register);
        if (reg === '+' || reg === '*') {
          registerManager.setClipboard(text);
        } else {
          registerManager.yank(focusedAgent.id, text, 'char', reg, append);
          if (!result.register) {
            const b64 = Buffer.from(text).toString('base64');
            process.stdout.write(`\x1b]52;c;${b64}\x07`);
          }
        }
        break;
      }

      case 'yank_to_eol': {
        if (!focusedAgent) break;
        const text = extractToEndOfLine(focusedAgent, vimState.normalCursor.line, vimState.normalCursor.col);
        if (!text) break;
        const reg = result.register?.toLowerCase();
        const append = result.register && /[A-Z]/.test(result.register);
        if (reg === '+' || reg === '*') {
          registerManager.setClipboard(text);
        } else {
          registerManager.yank(focusedAgent.id, text, 'char', reg, append);
          if (!result.register) {
            const b64 = Buffer.from(text).toString('base64');
            process.stdout.write(`\x1b]52;c;${b64}\x07`);
          }
        }
        break;
      }

      case 'yank_to_bol': {
        if (!focusedAgent) break;
        const text = extractFromStartOfLine(focusedAgent, vimState.normalCursor.line, vimState.normalCursor.col);
        if (!text) break;
        const reg = result.register?.toLowerCase();
        const append = result.register && /[A-Z]/.test(result.register);
        if (reg === '+' || reg === '*') {
          registerManager.setClipboard(text);
        } else {
          registerManager.yank(focusedAgent.id, text, 'char', reg, append);
          if (!result.register) {
            const b64 = Buffer.from(text).toString('base64');
            process.stdout.write(`\x1b]52;c;${b64}\x07`);
          }
        }
        break;
      }

      case 'yank_to_start': {
        // ygg - yank from current line to buffer start
        if (!focusedAgent) break;
        const lines = [];
        for (let i = 0; i <= vimState.normalCursor.line; i++) {
          lines.push(focusedAgent.getLineText(i));
        }
        const text = lines.join('\n');
        if (!text) break;
        const reg = result.register?.toLowerCase();
        const append = result.register && /[A-Z]/.test(result.register);
        if (reg === '+' || reg === '*') {
          registerManager.setClipboard(text);
        } else {
          registerManager.yank(focusedAgent.id, text, 'line', reg, append);
          if (!result.register) {
            const b64 = Buffer.from(text).toString('base64');
            process.stdout.write(`\x1b]52;c;${b64}\x07`);
          }
        }
        break;
      }

      case 'yank_to_end': {
        // yG - yank from current line to buffer end
        if (!focusedAgent) break;
        const contentHeight = focusedAgent.getContentHeight();
        const lines = [];
        for (let i = vimState.normalCursor.line; i < contentHeight; i++) {
          lines.push(focusedAgent.getLineText(i));
        }
        const text = lines.join('\n');
        if (!text) break;
        const reg = result.register?.toLowerCase();
        const append = result.register && /[A-Z]/.test(result.register);
        if (reg === '+' || reg === '*') {
          registerManager.setClipboard(text);
        } else {
          registerManager.yank(focusedAgent.id, text, 'line', reg, append);
          if (!result.register) {
            const b64 = Buffer.from(text).toString('base64');
            process.stdout.write(`\x1b]52;c;${b64}\x07`);
          }
        }
        break;
      }

      // Delete operators - in read-only terminal, just yank
      case 'delete_lines':
      case 'delete_word':
      case 'delete_word_end':
      case 'delete_to_eol':
      case 'delete_to_bol':
      case 'delete_to_first_nonblank':
      case 'delete_to_start':
      case 'delete_to_end':
        // Remap delete to equivalent yank action
        // (We're in a read-only terminal viewer)
        break;

      case 'paste':
        pasteFromRegister(result.after, result.register);
        break;

      case 'await_register':
        vimState.awaitingRegister = true;
        break;

      case 'register_selected':
        vimState.selectedRegister = result.register;
        vimState.awaitingRegister = false;
        break;

      case 'await_motion':
      case 'operator_cancelled':
      case 'invalid_motion':
      case 'invalid_register':
        // These are handled by InputRouter state, nothing to do here
        break;

      case 'visual_cancel':
        vimState.mode = 'normal';
        break;

      // Layout navigation (focus_direction, focus_next, focus_prev) -> extracted to handlers/layout

      // Split operations
      case 'split_horizontal': {
        const agentType = result.agentType || 'claude';
        const extraArgs = result.extraArgs || [];

        if (agentType === 'chat') {
          // Chat split - show conversation picker
          showConversationPicker('horizontal');
        } else {
          const newAgent = createNewAgent(agentType, extraArgs);
          const newPane = layoutManager.splitHorizontal(newAgent.id);
          if (newPane) {
            newAgent.spawn(newPane.bounds.width, newPane.bounds.height);
            setupAgentHandlers(newAgent);
          }
          handleResize();
        }
        break;
      }

      case 'split_vertical': {
        const agentType = result.agentType || 'claude';
        const extraArgs = result.extraArgs || [];

        if (agentType === 'chat') {
          // Chat split - show conversation picker
          showConversationPicker('vertical');
        } else {
          const newAgent = createNewAgent(agentType, extraArgs);
          const newPane = layoutManager.splitVertical(newAgent.id);
          if (newPane) {
            newAgent.spawn(newPane.bounds.width, newPane.bounds.height);
            setupAgentHandlers(newAgent);
          }
          handleResize();
        }
        break;
      }

      // Pane management
      case 'close_pane': {
        const paneToClose = layoutManager.getFocusedPane();
        if (paneToClose) {
          const paneId = paneToClose.id;
          const agentToKill = session.getAgent(paneToClose.agentId);
          if (layoutManager.closePane()) {
            compositor.cleanupPane(paneId);  // Clear reflow timers and state
            if (agentToKill) {
              session.removeAgent(agentToKill.id);
            }
            handleResize();
          }
        }
        break;
      }

      case 'close_others':
        layoutManager.closeOthers();
        handleResize();
        break;

      case 'new_tab': {
        // Create new tab with agent (closes others, replaces current)
        const agentType = result.agentType || 'claude';
        const extraArgs = result.extraArgs || [];
        const newAgent = createNewAgent(agentType, extraArgs);

        // Close all other panes and make this the only one
        layoutManager.closeOthers();

        // Replace the current pane's agent
        const currentPane = layoutManager.getFocusedPane();
        if (currentPane) {
          const oldAgent = session.getAgent(currentPane.agentId);
          if (oldAgent) {
            session.removeAgent(oldAgent.id);
          }
          currentPane.agentId = newAgent.id;
          newAgent.spawn(currentPane.bounds.width, currentPane.bounds.height);
          setupAgentHandlers(newAgent);
        }
        handleResize();
        break;
      }

      // Resize
      case 'equalize':
        layoutManager.equalize();
        handleResize();
        break;

      case 'zoom_toggle':
        layoutManager.toggleZoom();
        handleResize();
        break;

      case 'resize':
        layoutManager.resizeFocused(result.delta);
        handleResize();
        break;

      // Tab switching
      case 'switch_tab': {
        const panes = layoutManager.getAllPanes();
        if (result.index < panes.length) {
          layoutManager.focusPane(panes[result.index].id);
        }
        break;
      }

      case 'prev_tab':
        layoutManager.cycleFocus(false);
        break;

      case 'next_tab':
        layoutManager.cycleFocus(true);
        break;

      // Normal mode cursor movement (moves virtual cursor, ensures visibility)
      case 'cursor_down': {
        if (!focusedAgent) break;
        const contentHeight = focusedAgent.getContentHeight();
        for (let i = 0; i < (result.count || 1); i++) {
          if (vimState.normalCursor.line < contentHeight - 1) {
            vimState.normalCursor.line++;
          }
        }
        ensureLineVisible(vimState.normalCursor.line);
        break;
      }

      case 'cursor_up': {
        for (let i = 0; i < (result.count || 1); i++) {
          if (vimState.normalCursor.line > 0) {
            vimState.normalCursor.line--;
          }
        }
        ensureLineVisible(vimState.normalCursor.line);
        break;
      }

      case 'cursor_left': {
        for (let i = 0; i < (result.count || 1); i++) {
          if (vimState.normalCursor.col > 0) {
            vimState.normalCursor.col--;
          }
        }
        break;
      }

      case 'cursor_right': {
        if (!focusedAgent) break;
        const lineText = focusedAgent.getLineText(vimState.normalCursor.line) || '';
        for (let i = 0; i < (result.count || 1); i++) {
          if (vimState.normalCursor.col < lineText.length - 1) {
            vimState.normalCursor.col++;
          }
        }
        break;
      }

      // Scrolling (Ctrl+D/U/F/B for page navigation)
      case 'scroll_down':
        compositor.scrollFocused(result.count || 1);
        break;

      case 'scroll_up':
        compositor.scrollFocused(-(result.count || 1));
        break;

      case 'scroll_half_down':
        compositor.scrollFocused(Math.floor((focusedPane?.bounds.height || 12) / 2));
        break;

      case 'scroll_half_up':
        compositor.scrollFocused(-Math.floor((focusedPane?.bounds.height || 12) / 2));
        break;

      case 'scroll_page_down':
        compositor.scrollFocused(focusedPane?.bounds.height || 24);
        break;

      case 'scroll_page_up':
        compositor.scrollFocused(-(focusedPane?.bounds.height || 24));
        break;

      case 'scroll_to_bottom':
        compositor.scrollFocusedTo('bottom');
        if (focusedAgent) {
          vimState.normalCursor.line = focusedAgent.getContentHeight() - 1;
          vimState.normalCursor.col = 0;
        }
        break;

      case 'scroll_to_top':
        compositor.scrollFocusedTo('top');
        vimState.normalCursor.line = 0;
        vimState.normalCursor.col = 0;
        break;

      // Line position movements
      case 'cursor_line_start':
        vimState.normalCursor.col = 0;
        break;

      case 'cursor_line_end':
        if (focusedAgent) {
          const lineText = focusedAgent.getLineText(vimState.normalCursor.line) || '';
          vimState.normalCursor.col = Math.max(0, lineText.length - 1);
        }
        break;

      case 'cursor_first_nonblank':
        if (focusedAgent) {
          const lineText = focusedAgent.getLineText(vimState.normalCursor.line) || '';
          const match = lineText.match(/^\s*/);
          vimState.normalCursor.col = match ? match[0].length : 0;
        }
        break;

      // Word movements in normal mode
      case 'word_forward':
        if (focusedAgent) {
          for (let i = 0; i < (result.count || 1); i++) {
            moveWordForward(focusedAgent, vimState.normalCursor, result.bigWord);
          }
          ensureLineVisible(vimState.normalCursor.line);
        }
        break;

      case 'word_end':
        if (focusedAgent) {
          for (let i = 0; i < (result.count || 1); i++) {
            moveWordEnd(focusedAgent, vimState.normalCursor, result.bigWord);
          }
          ensureLineVisible(vimState.normalCursor.line);
        }
        break;

      case 'word_backward':
        if (focusedAgent) {
          for (let i = 0; i < (result.count || 1); i++) {
            moveWordBackward(focusedAgent, vimState.normalCursor, result.bigWord);
          }
          ensureLineVisible(vimState.normalCursor.line);
        }
        break;

      // Character find (f/F/t/T) in normal mode
      case 'find_char':
        if (focusedAgent) {
          const lineText = focusedAgent.getLineText(vimState.normalCursor.line) || '';
          const newCol = findCharOnLine(lineText, vimState.normalCursor.col, result.char, result.type, result.count || 1);
          if (newCol >= 0) {
            vimState.normalCursor.col = newCol;
          }
        }
        break;

      // Character find in visual mode
      case 'extend_find_char':
        if ((vimState.mode === 'visual' || vimState.mode === 'vline') && focusedAgent) {
          const lineText = focusedAgent.getLineText(vimState.visualCursor.line) || '';
          const newCol = findCharOnLine(lineText, vimState.visualCursor.col, result.char, result.type, result.count || 1);
          if (newCol >= 0) {
            vimState.visualCursor.col = newCol;
          }
        }
        break;

      // Search actions
      case 'search_start':
        searchState.previousMode = vimState.mode;  // Remember mode for visual extension
        searchState.active = true;
        searchState.pattern = '';
        searchState.direction = result.direction || 'forward';
        break;

      case 'search_char':
        if (searchState.active) {
          searchState.pattern += result.char;
        }
        break;

      case 'search_backspace':
        if (searchState.active) {
          searchState.pattern = searchState.pattern.slice(0, -1);
        }
        break;

      case 'search_delete_word':
        if (searchState.active) {
          // Remove last word (or to last space)
          searchState.pattern = searchState.pattern.replace(/\S*\s*$/, '');
        }
        break;

      case 'search_clear':
        if (searchState.active) {
          searchState.pattern = '';
        }
        break;

      case 'search_confirm':
        searchState.active = false;
        executeSearch();
        // If we were in visual mode, extend selection to match
        if ((searchState.previousMode === 'visual' || searchState.previousMode === 'vline') &&
            searchState.matches.length > 0) {
          const match = searchState.matches[searchState.index];
          vimState.mode = searchState.previousMode;  // Restore visual mode
          vimState.visualCursor.line = match.line;
          vimState.visualCursor.col = match.col;
          ensureLineVisible(match.line);
        }
        break;

      case 'search_cancel':
        searchState.active = false;
        // Keep matches for highlighting
        break;

      case 'search_next':
        if (searchState.matches.length > 0) {
          searchState.index = (searchState.index + 1) % searchState.matches.length;
          jumpToMatch();
        }
        break;

      case 'search_prev':
        if (searchState.matches.length > 0) {
          searchState.index = (searchState.index - 1 + searchState.matches.length) % searchState.matches.length;
          jumpToMatch();
        }
        break;

      // Command mode
      case 'command_start':
        commandState.active = true;
        commandState.buffer = '';
        break;

      case 'command_update':
        commandState.buffer = result.buffer;
        break;

      case 'command_cancel':
        commandState.active = false;
        commandState.buffer = '';
        break;

      case 'command_execute':
        commandState.active = false;
        commandState.buffer = '';
        executeCommand(result.command);
        break;

      // Session management
      case 'save_session':
        session.save(undefined, fipaHub.conversations).then(filepath => {
          // Flash message would go here
        }).catch(() => {});
        break;

      // Quit
      case 'quit_force':
        terminal.cleanup();
        if (ipcHub) ipcHub.stop();
        session.destroy();
        process.exit(0);
        break;

      case 'quit_confirm':
        // For now, just quit
        terminal.cleanup();
        if (ipcHub) ipcHub.stop();
        session.destroy();
        process.exit(0);
        break;

      // Passthrough handled directly
      case 'passthrough':
        // Already written to agent in InputRouter
        compositor.resetCursorBlink();
        break;

      // FIPA Actions - open chat pane with specific performative
      case 'fipa_request':
      case 'fipa_inform':
      case 'fipa_query_if':
      case 'fipa_query_ref':
      case 'fipa_cfp':
      case 'fipa_propose':
      case 'fipa_agree':
      case 'fipa_refuse':
      case 'fipa_subscribe': {
        // Map action to performative
        const perfMap = {
          'fipa_request': 'request',
          'fipa_inform': 'inform',
          'fipa_query_if': 'query-if',
          'fipa_query_ref': 'query-ref',
          'fipa_cfp': 'cfp',
          'fipa_propose': 'propose',
          'fipa_agree': 'agree',
          'fipa_refuse': 'refuse',
          'fipa_subscribe': 'subscribe'
        };
        const performative = perfMap[result.action] || 'inform';

        // Find or create chat pane
        const chatPanes = layoutManager.getAllPanes().filter(p => p.agentId.startsWith('chat-'));
        if (chatPanes.length > 0) {
          // Focus existing chat pane and set performative
          layoutManager.focusPane(chatPanes[chatPanes.length - 1].id);
          const chatAgent = session.getAgent(chatPanes[chatPanes.length - 1].agentId);
          if (chatAgent) chatAgent.performative = performative;
        } else {
          // Create new chat pane with this performative
          showConversationPicker('horizontal');
          // Store performative to apply after pane creation
          chatState.pendingPerformative = performative;
        }
        compositor.draw();
        break;
      }

      // Chat mode actions (legacy - now handled by ChatAgent)
      case 'chat_char':
        chatState.inputBuffer += result.char;
        compositor.draw();
        break;

      case 'chat_backspace':
        chatState.inputBuffer = chatState.inputBuffer.slice(0, -1);
        compositor.draw();
        break;

      case 'chat_delete_word':
        chatState.inputBuffer = chatState.inputBuffer.replace(/\S*\s*$/, '');
        compositor.draw();
        break;

      case 'chat_clear':
        chatState.inputBuffer = '';
        compositor.draw();
        break;

      case 'chat_exit':
        chatState.inputBuffer = '';
        chatState.selectedAgent = null;
        inputRouter.setMode('insert');
        compositor.draw();
        break;

      case 'chat_cycle_agent': {
        const agents = session.getAllAgents();
        if (agents.length === 0) break;
        const currentIdx = chatState.selectedAgent
          ? agents.findIndex(a => a.id === chatState.selectedAgent)
          : -1;
        const nextIdx = (currentIdx + 1) % agents.length;
        chatState.selectedAgent = agents[nextIdx].id;
        compositor.draw();
        break;
      }

      case 'chat_cycle_agent_back': {
        const agents = session.getAllAgents();
        if (agents.length === 0) break;
        const currentIdx = chatState.selectedAgent
          ? agents.findIndex(a => a.id === chatState.selectedAgent)
          : 0;
        const prevIdx = currentIdx <= 0 ? agents.length - 1 : currentIdx - 1;
        chatState.selectedAgent = agents[prevIdx].id;
        compositor.draw();
        break;
      }

      case 'chat_cycle_performative': {
        const performatives = ['inform', 'request', 'query-if', 'query-ref', 'cfp', 'propose', 'agree', 'refuse', 'subscribe'];
        const currentIdx = performatives.indexOf(chatState.pendingPerformative);
        const nextIdx = (currentIdx + 1) % performatives.length;
        chatState.pendingPerformative = performatives[nextIdx];
        compositor.draw();
        break;
      }

      case 'chat_scroll_up':
        chatPane.scrollUp(3);
        compositor.draw();
        break;

      case 'chat_scroll_down':
        chatPane.scrollDown(3);
        compositor.draw();
        break;

      case 'chat_prev_conversation':
        chatPane.prevConversation();
        compositor.draw();
        break;

      case 'chat_next_conversation':
        chatPane.nextConversation();
        compositor.draw();
        break;

      case 'chat_send': {
        // Send FIPA message from focused agent to selected agent
        const fromAgent = focusedAgent;
        const toAgentId = chatState.selectedAgent;
        const content = chatState.inputBuffer.trim();

        if (!fromAgent || !toAgentId || !content) {
          // Need to select target agent first
          if (!toAgentId) {
            chatState.showAgentPicker = true;
          }
          compositor.draw();
          break;
        }

        // Get the target agent
        const toAgent = session.getAgent(toAgentId);
        if (!toAgent) break;

        // Send via FIPAHub based on performative
        const perf = chatState.pendingPerformative;
        switch (perf) {
          case 'request':
            fipaHub.request(fromAgent.id, toAgent.id, content);
            break;
          case 'inform':
            fipaHub.inform(fromAgent.id, toAgent.id, content);
            break;
          case 'query-if':
            fipaHub.queryIf(fromAgent.id, toAgent.id, content);
            break;
          case 'query-ref':
            fipaHub.queryRef(fromAgent.id, toAgent.id, content);
            break;
          case 'cfp':
            // CFP broadcasts to all agents except sender
            const otherAgents = session.getAllAgents()
              .filter(a => a.id !== fromAgent.id)
              .map(a => a.id);
            fipaHub.cfp(fromAgent.id, otherAgents, { task: content });
            break;
          case 'subscribe':
            fipaHub.subscribe(fromAgent.id, toAgent.id, { topic: content });
            break;
          default:
            // For propose, agree, refuse - use inform as fallback
            fipaHub.inform(fromAgent.id, toAgent.id, { [perf]: content });
        }

        // Clear input after sending
        chatState.inputBuffer = '';
        compositor.draw();
        break;
      }

      // ========================================
      // ACL Send Mode Actions (overlay-based)
      // ========================================

      case 'acl_send_start': {
        // Extract selected text if in visual mode
        let text = '';
        if (vimState.mode === 'visual' || vimState.mode === 'vline') {
          text = extractSelectedText(focusedAgent, vimState);
        }

        aclState.active = true;
        aclState.selectedText = text;
        aclState.sourceAgent = focusedAgent?.id || null;
        aclState.performative = result.performative || 'inform';

        // Get terminal dimensions for centering
        const cols = process.stdout.columns || 80;
        const rows = process.stdout.rows || 24;
        const overlayWidth = Math.min(60, cols - 10);
        const overlayHeight = Math.min(12, rows - 6);

        // Show ACL input overlay centered on screen
        const overlay = overlayManager.show({
          id: 'acl-input',
          type: 'acl-input',
          x: Math.floor((cols - overlayWidth) / 2),
          y: Math.floor((rows - overlayHeight) / 2),
          width: overlayWidth,
          height: overlayHeight,
          performative: aclState.performative,
          sourceAgent: focusedAgent?.id,
          targetAgent: aclState.targetAgent,
          content: text,
          agents: session.getAllAgents().map(a => ({ id: a.id, name: a.name, type: a.type }))
        });

        aclState.overlayId = overlay.id;
        inputRouter.setMode('acl-send');
        vimState.mode = 'insert';  // Exit visual mode
        compositor.draw();
        break;
      }

      case 'acl_target_direction': {
        // Find agent in that direction
        const targetPane = layoutManager.findPaneInDirection(result.dir);
        if (targetPane) {
          const agent = session.getAgent(targetPane.agentId);
          if (agent) {
            aclState.targetAgent = agent.id;

            // Update overlay
            const overlay = overlayManager.get(aclState.overlayId);
            if (overlay) {
              overlay.setTarget(agent.id);
            }
            compositor.draw();
          }
        } else {
          // No pane in that direction -> show agent picker
          const overlay = overlayManager.get(aclState.overlayId);
          if (overlay && overlay.showAgentPicker) {
            overlay.showAgentPicker(session.getAllAgents().map(a => ({
              id: a.id,
              name: a.name,
              type: a.type
            })));
            aclState.agentPickerActive = true;
            compositor.draw();
          }
        }
        break;
      }

      case 'acl_cycle_agent': {
        const agents = session.getAllAgents().filter(a => a.id !== aclState.sourceAgent);
        if (agents.length === 0) break;

        const currentIdx = aclState.targetAgent
          ? agents.findIndex(a => a.id === aclState.targetAgent)
          : -1;
        const nextIdx = (currentIdx + 1) % agents.length;
        aclState.targetAgent = agents[nextIdx].id;

        // Update overlay
        const overlay = overlayManager.get(aclState.overlayId);
        if (overlay) {
          overlay.setTarget(aclState.targetAgent);
        }
        compositor.draw();
        break;
      }

      case 'acl_cycle_agent_back': {
        const agents = session.getAllAgents().filter(a => a.id !== aclState.sourceAgent);
        if (agents.length === 0) break;

        const currentIdx = aclState.targetAgent
          ? agents.findIndex(a => a.id === aclState.targetAgent)
          : 0;
        const prevIdx = currentIdx <= 0 ? agents.length - 1 : currentIdx - 1;
        aclState.targetAgent = agents[prevIdx].id;

        // Update overlay
        const overlay = overlayManager.get(aclState.overlayId);
        if (overlay) {
          overlay.setTarget(aclState.targetAgent);
        }
        compositor.draw();
        break;
      }

      case 'acl_cycle_performative': {
        const performatives = ['inform', 'request', 'query-if', 'query-ref', 'cfp', 'propose', 'agree', 'refuse', 'subscribe'];
        const currentIdx = performatives.indexOf(aclState.performative);
        const nextIdx = (currentIdx + 1) % performatives.length;
        aclState.performative = performatives[nextIdx];

        // Update overlay
        const overlay = overlayManager.get(aclState.overlayId);
        if (overlay) {
          overlay.setPerformative(aclState.performative);
        }
        compositor.draw();
        break;
      }

      case 'acl_send': {
        const overlay = overlayManager.get(aclState.overlayId);
        if (!overlay) break;

        if (!aclState.targetAgent) {
          // Need to select target agent first - show picker
          if (overlay.showAgentPicker) {
            overlay.showAgentPicker(session.getAllAgents().map(a => ({
              id: a.id,
              name: a.name,
              type: a.type
            })));
            aclState.agentPickerActive = true;
          }
          compositor.draw();
          break;
        }

        const content = overlay.inputBuffer;
        if (!content.trim()) {
          compositor.draw();
          break;
        }

        // Get the target agent
        const toAgent = session.getAgent(aclState.targetAgent);
        if (!toAgent) break;

        // Send via FIPAHub based on performative
        const perf = aclState.performative;
        const fromId = aclState.sourceAgent;

        switch (perf) {
          case 'request':
            fipaHub.request(fromId, toAgent.id, content);
            break;
          case 'inform':
            fipaHub.inform(fromId, toAgent.id, content);
            break;
          case 'query-if':
            fipaHub.queryIf(fromId, toAgent.id, content);
            break;
          case 'query-ref':
            fipaHub.queryRef(fromId, toAgent.id, content);
            break;
          case 'cfp':
            // CFP broadcasts to all agents except sender
            const otherAgents = session.getAllAgents()
              .filter(a => a.id !== fromId)
              .map(a => a.id);
            fipaHub.cfp(fromId, otherAgents, { task: content });
            break;
          case 'subscribe':
            fipaHub.subscribe(fromId, toAgent.id, { topic: content });
            break;
          default:
            // For propose, agree, refuse - use inform as fallback
            fipaHub.inform(fromId, toAgent.id, { [perf]: content });
        }

        // Cleanup
        overlayManager.hide(aclState.overlayId);
        aclState.active = false;
        aclState.overlayId = null;
        aclState.targetAgent = null;
        aclState.selectedText = '';
        inputRouter.setMode('insert');
        compositor.draw();
        break;
      }

      case 'acl_cancel': {
        // Close overlay without sending
        if (aclState.overlayId) {
          overlayManager.hide(aclState.overlayId);
        }
        aclState.active = false;
        aclState.overlayId = null;
        aclState.targetAgent = null;
        aclState.selectedText = '';
        aclState.agentPickerActive = false;
        compositor.draw();
        break;
      }

      case 'acl_char': {
        const overlay = overlayManager.get(aclState.overlayId);
        if (overlay) {
          overlay.addChar(result.char);
          compositor.draw();
        }
        break;
      }

      case 'acl_backspace': {
        const overlay = overlayManager.get(aclState.overlayId);
        if (overlay) {
          overlay.backspace();
          compositor.draw();
        }
        break;
      }

      case 'acl_delete_word': {
        const overlay = overlayManager.get(aclState.overlayId);
        if (overlay) {
          overlay.deleteWord();
          compositor.draw();
        }
        break;
      }

      case 'acl_clear': {
        const overlay = overlayManager.get(aclState.overlayId);
        if (overlay) {
          overlay.clear();
          compositor.draw();
        }
        break;
      }

      case 'acl_cursor_left': {
        const overlay = overlayManager.get(aclState.overlayId);
        if (overlay) {
          overlay.cursorLeft();
          compositor.draw();
        }
        break;
      }

      case 'acl_cursor_right': {
        const overlay = overlayManager.get(aclState.overlayId);
        if (overlay) {
          overlay.cursorRight();
          compositor.draw();
        }
        break;
      }

      case 'acl_need_target': {
        // Show agent picker overlay
        const overlay = overlayManager.get(aclState.overlayId);
        if (overlay && overlay.showAgentPicker) {
          overlay.showAgentPicker(session.getAllAgents().map(a => ({
            id: a.id,
            name: a.name,
            type: a.type
          })));
          aclState.agentPickerActive = true;
          compositor.draw();
        }
        break;
      }
    }
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
    onMoveVisualCursor: moveVisualCursor
  });
  dispatcher.setFallbackHandler(handleAction);

  // Input handling
  process.stdin.on('data', (data) => {
    const str = data.toString();

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
        // Left click (btn 0) - focus pane under mouse
        if (baseBtn === 0 && !isShift && !isCtrl && !isMeta) {
          const pane = layoutManager.findPaneAt(mx, my);
          if (pane && pane.id !== layoutManager.focusedPaneId) {
            layoutManager.focusPane(pane.id);
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
        onAgentOutputDuringReflow();  // Smart reflow detection

        const pane = layoutManager.findPaneByAgent(agent.id);
        if (pane) {
          // Detect full refresh sequences
          if (data.includes('\x1b[2J') || data.includes('\x1b[H\x1b[J')) {
            compositor.enterOutputReflow(pane.id);
          }
          compositor.checkOutputReflow(pane.id, agent);
        }

        compositor.scheduleDraw();
      });
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
    if (mcpServer) mcpServer.stop();
    if (ipcHub) ipcHub.stop();
    if (fipaHub) fipaHub.shutdown();
    session.destroy();
  });

  // Handle agent exit for initial agents (onData already set up above)
  for (const agent of session.getAllAgents()) {
    if (agent.pty) {
      agent.pty.onExit(({ exitCode }) => {
        const pane = layoutManager.findPaneByAgent(agent.id);
        if (pane) {
          layoutManager.focusPane(pane.id);
          const allPanes = layoutManager.getAllPanes();
          if (allPanes.length === 1) {
            terminal.cleanup();
            if (ipcHub) ipcHub.stop();
            session.destroy();
            process.exit(exitCode);
          } else {
            const paneId = pane.id;
            layoutManager.closePane();
            compositor.cleanupPane(paneId);  // Clear reflow timers and state
            session.removeAgent(agent.id);
            handleResize();
          }
        }
      });
    }
  }

})();
