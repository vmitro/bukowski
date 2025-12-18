#!/usr/bin/env node
// bukowski multi-agent terminal - v1.1

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const { Session } = require('./src/core/Session');
const { Agent } = require('./src/core/Agent');
const { LayoutManager } = require('./src/layout/LayoutManager');
const { Compositor } = require('./src/core/Compositor');
const { InputRouter } = require('./src/input/InputRouter');
const { IPCHub } = require('./src/ipc/IPCHub');
const { FIPAHub } = require('./src/acl/FIPAHub');
const { TabBar } = require('./src/ui/TabBar');
const { ChatPane } = require('./src/ui/ChatPane');
const { ConversationList } = require('./src/ui/ConversationList');
const { LayoutNode } = require('./src/layout/LayoutNode');
const { RegisterManager } = require('./src/input/RegisterManager');
const { findLatestSession } = require('./src/utils/agentSessions');
const { OverlayManager } = require('./src/ui/OverlayManager');
const { MCPServer } = require('./src/mcp/MCPServer');
const os = require('os');

// Socket discovery file for MCP bridge
const SOCKET_DISCOVERY_FILE = path.join(os.homedir(), '.bukowski-mcp-socket');

// Load quotes from quotes.txt
const quotesPath = path.join(__dirname, 'quotes.txt');
let QUOTES = [];
try {
  const raw = fs.readFileSync(quotesPath, 'utf8');
  QUOTES = raw.split(/\n\n+/).filter(Boolean).map(block => {
    const lines = block.trim().split('\n');
    const author = lines.pop().replace(/^—\s*/, '');
    const text = lines.join(' ');
    return { text, author };
  });
} catch {
  QUOTES = [{ text: "Let there be light.", author: "bukowski" }];
}

function showSplash() {
  const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  const lines = quote.text.match(new RegExp(`.{1,${cols - 4}}(\\s|$)`, 'g')) || [quote.text];
  const authorLine = `— ${quote.author}`;

  const startRow = Math.floor((rows - lines.length - 2) / 2);

  let frame = '\x1b[2J\x1b[H';
  frame += '\x1b[?25l';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const col = Math.floor((cols - line.length) / 2);
    frame += `\x1b[${startRow + i};${col}H\x1b[3m${line}\x1b[0m`;
  }

  const authorCol = Math.floor((cols - authorLine.length) / 2);
  frame += `\x1b[${startRow + lines.length + 1};${authorCol}H\x1b[2m${authorLine}\x1b[0m`;

  process.stdout.write(frame);
}

// Find Claude CLI
let claudePath;
try {
  const claudeBin = execSync('readlink -f "$(which claude)"', { encoding: 'utf8' }).trim();
  const claudeDir = path.dirname(claudeBin);
  claudePath = path.join(claudeDir, 'cli.js');
} catch {
  claudePath = 'claude'; // Fallback
}

// Find Codex CLI
let codexPath;
try {
  const codexBin = execSync('readlink -f "$(which codex)"', { encoding: 'utf8' }).trim();
  codexPath = codexBin;
} catch {
  codexPath = null; // Not installed
}

// FIPA reminder prompt for agents
const FIPA_REMINDER = `You are running inside bukowski, a multi-agent terminal. Other AI agents may be running alongside you.

Available tools (via MCP):
- list_agents: See other connected agents
- fipa_request: Ask another agent to do something
- fipa_inform: Share information with another agent
- fipa_query_if: Ask a yes/no question
- fipa_query_ref: Ask for specific information
- get_pending_messages: Check for messages from other agents

When you're unsure about something outside your expertise, consider asking another agent.`;

// Agent type configurations
const AGENT_TYPES = {
  claude: {
    command: 'node',
    args: [claudePath],
    name: 'Claude',
    promptFlag: '--append-system-prompt',
    // Generate resume args based on session ID
    getResumeArgs: (sessionId) => sessionId
      ? ['--resume', sessionId]
      : ['--continue']  // fallback to latest
  },
  codex: {
    command: 'node',
    args: codexPath ? [codexPath] : [],
    name: 'Codex',
    promptFlag: null,  // Codex uses positional arg, tricky with resume - skip for now
    getResumeArgs: (sessionId) => sessionId
      ? ['resume', sessionId]
      : ['resume', '--last']
  },
  gemini: {
    command: 'gemini',
    args: [],
    name: 'Gemini',
    promptFlag: null,  // Gemini uses positional arg - skip for now
    getResumeArgs: (sessionId) => sessionId
      ? ['-r', sessionId]
      : ['-r', 'latest']  // Fallback: latest in current project (Gemini is project-scoped)
  }
};

/**
 * Get FIPA prompt args for an agent type
 * @param {string} agentType
 * @param {string[]} existingArgs
 * @returns {string[]} Args to append
 */
function getFIPAPromptArgs(agentType, existingArgs) {
  const config = AGENT_TYPES[agentType];
  if (!config || !config.promptFlag) return [];

  // Don't inject if user already provided this flag
  if (existingArgs.includes(config.promptFlag)) {
    return [];
  }

  return [config.promptFlag, FIPA_REMINDER];
}

// Parse CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    restore: null,       // Session ID/name to restore, or 'latest'
    sessionName: null,   // New session name
    agentArgs: []        // Args to pass to initial agent
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--restore' || arg === '--resume' || arg === '-r') {
      // Check if next arg exists and is not a flag
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith('-')) {
        result.restore = nextArg;
        i++; // Skip next arg
      } else {
        result.restore = 'latest';
      }
    } else if (arg === '--session' || arg === '-s') {
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith('-')) {
        result.sessionName = nextArg;
        i++;
      }
    } else if (arg === '--help' || arg === '-h') {
      console.log(`bukowski - multi-agent terminal

Usage: bukowski [options] [-- agent-args...]

Options:
  -r, --restore [id|name]  Restore a saved session (default: latest)
      --resume             Alias for --restore
  -s, --session <name>     Set session name
  -h, --help               Show this help

Session Commands (in normal mode, type :):
  :w [name]                Save session (optionally with new name)
  :wq, :x                  Save and quit
  :sessions                List saved sessions
  :restore <id|name>       Show restore instructions
  :name <name>             Rename current session

Examples:
  bukowski                           Start new session
  bukowski --restore                 Restore most recent session
  bukowski --restore myproject       Restore session named "myproject"
  bukowski -s "My Project"           Start new session with name
`);
      process.exit(0);
    } else if (arg === '--') {
      result.agentArgs = args.slice(i + 1);
      break;
    } else {
      result.agentArgs.push(arg);
    }
  }

  return result;
}

const cliArgs = parseArgs();

// Cleanup function - exit alt screen, restore cursor, disable mouse
function cleanup() {
  process.stdout.write('\x1b[?1000l\x1b[?1006l'); // Disable mouse
  process.stdout.write('\x1b[?25h');              // Show cursor
  process.stdout.write('\x1b[?1049l');            // Exit alt screen

  // Remove socket discovery file
  try {
    fs.unlinkSync(SOCKET_DISCOVERY_FILE);
  } catch {
    // Ignore - file may not exist
  }
}

// Setup function - enter alt screen, enable mouse
function setupTerminal() {
  process.stdout.write('\x1b[?1049h');            // Enter alt screen
  process.stdout.write('\x1b[?1000h\x1b[?1006h'); // Enable mouse (SGR mode)
  process.stdout.write('\x1b[?25l');              // Hide cursor (compositor manages it)
}

process.on('exit', cleanup);

// Track session globally for signal handlers
let activeSession = null;
let activeCompositor = null;

// SIGTSTP handler (CTRL+Z) - suspend gracefully
process.on('SIGTSTP', () => {
  // 1. Clean up terminal state
  cleanup();

  // 2. Stop all child PTYs
  if (activeSession) {
    for (const agent of activeSession.getAllAgents()) {
      if (agent.pty && agent.pty.pid) {
        try {
          process.kill(agent.pty.pid, 'SIGSTOP');
        } catch {
          // Process may have already exited
        }
      }
    }
  }

  // 3. Actually suspend ourselves
  // We need to re-send SIGTSTP with default handler to actually stop
  process.kill(process.pid, 'SIGSTOP');
});

// SIGCONT handler - resume after suspend
process.on('SIGCONT', () => {
  // 1. Resume all child PTYs
  if (activeSession) {
    for (const agent of activeSession.getAllAgents()) {
      if (agent.pty && agent.pty.pid) {
        try {
          process.kill(agent.pty.pid, 'SIGCONT');
        } catch {
          // Process may have already exited
        }
      }
    }
  }

  // 2. Restore terminal state
  setupTerminal();

  // 3. Force full redraw (immediate)
  if (activeCompositor) {
    activeCompositor.draw();
  }
});

// Main async startup
(async () => {
  // Enter alt screen
  process.stdout.write('\x1b[?1049h');

  // Show splash
  showSplash();

  const SPLASH_DURATION = parseInt(process.env.BUKOWSKI_SPLASH) || 2000;

  // Wait for splash duration
  await new Promise(resolve => setTimeout(resolve, SPLASH_DURATION));

  // Continue with main initialization
  let session;
  let restoredSession = false;

  // Try to restore session if requested
  if (cliArgs.restore) {
    try {
      const { LayoutNode } = require('./src/layout/LayoutNode');
      if (cliArgs.restore === 'latest') {
        session = await Session.loadLatest(Agent, LayoutNode);
      } else {
        session = await Session.loadByIdOrName(cliArgs.restore, Agent, LayoutNode);
      }
      if (session) {
        restoredSession = true;
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
    const fipaArgs = getFIPAPromptArgs('claude', initialArgs);
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
    // FIPA Hub does not need to be 'started' but we might listen to events etc
    // For now, just instantiate and connect
  } catch (err) {
    console.error('Warning: FIPA hub failed to initialize:', err.message);
  }

  // Start MCP Server for agent tool communication
  const mcpServer = new MCPServer(session, fipaHub, ipcHub);
  try {
    const socketPath = await mcpServer.start();
    // Wire FIPAHub messages to MCP message queue (for external agents)
    fipaHub.on('fipa:sent', ({ message, to }) => {
      if (to) {
        mcpServer.queueMessage(to, message);
      }
    });

    // Write socket path to discovery file for MCP bridge
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

  // Wire up global references for signal handlers
  activeSession = session;
  activeCompositor = compositor;

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
      if (agent) {
        const buffer = agent.getBuffer();
        if (buffer) {
          startLine = buffer.baseY + buffer.cursorY;
          startCol = buffer.cursorX;
        } else {
          startLine = 0;
          startCol = 0;
        }
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

  // Extract selected text from agent buffer
  function extractSelectedText(agent) {
    const anchor = vimState.visualAnchor;
    const cursor = vimState.visualCursor;

    // Determine start and end
    let start, end;
    if (anchor.line < cursor.line || (anchor.line === cursor.line && anchor.col <= cursor.col)) {
      start = anchor;
      end = cursor;
    } else {
      start = cursor;
      end = anchor;
    }

    const lines = [];
    for (let i = start.line; i <= end.line; i++) {
      const lineText = agent.getLineText(i);

      if (vimState.mode === 'vline') {
        // Visual line: full lines
        lines.push(lineText);
      } else {
        // Visual char: partial lines
        if (i === start.line && i === end.line) {
          lines.push(lineText.slice(start.col, end.col + 1));
        } else if (i === start.line) {
          lines.push(lineText.slice(start.col));
        } else if (i === end.line) {
          lines.push(lineText.slice(0, end.col + 1));
        } else {
          lines.push(lineText);
        }
      }
    }

    return lines.join('\n');
  }

  // Extract multiple lines from agent buffer
  function extractLines(agent, startLine, count) {
    const lines = [];
    const contentHeight = agent.getContentHeight();
    for (let i = startLine; i < startLine + count && i < contentHeight; i++) {
      lines.push(agent.getLineText(i));
    }
    return lines.join('\n');
  }

  // Extract word at cursor position
  function extractWord(agent, line, col) {
    const lineText = agent.getLineText(line) || '';
    let start = col, end = col;
    while (start > 0 && /\w/.test(lineText[start - 1])) start--;
    while (end < lineText.length && /\w/.test(lineText[end])) end++;
    return { text: lineText.slice(start, end), startCol: start, endCol: end - 1 };
  }

  // Extract text from cursor to end of line
  function extractToEndOfLine(agent, line, col) {
    const lineText = agent.getLineText(line) || '';
    return lineText.slice(col);
  }

  // Extract text from start of line to cursor
  function extractFromStartOfLine(agent, line, col) {
    const lineText = agent.getLineText(line) || '';
    return lineText.slice(0, col + 1);
  }

  // Yank selection to register
  function yankSelection(targetRegister = null) {
    const focusedPane = layoutManager.getFocusedPane();
    const agent = focusedPane ? session.getAgent(focusedPane.agentId) : null;
    if (!agent) return;

    const text = extractSelectedText(agent);
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

  // Handle terminal resize
  function handleResize() {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    compositor.resize(cols, rows);

    // Resize all agents
    for (const pane of layoutManager.getAllPanes()) {
      const agent = session.getAgent(pane.agentId);
      if (agent && agent.pty) {
        agent.resize(pane.bounds.width, pane.bounds.height);
      }
    }

    // Redraw with new dimensions
    compositor.draw();
  }

  // Execute ex-command
  // Helper to resolve agent type from argument
  function resolveAgentType(arg) {
    if (!arg) return 'claude'; // default
    const type = arg.toLowerCase();
    if (AGENT_TYPES[type] && AGENT_TYPES[type].command) {
      return type;
    }
    return null; // invalid type
  }

  // Capture agent session IDs from filesystem before saving
  // Always recapture - user might have run /resume inside the agent
  // Track already-assigned IDs to avoid giving same session to multiple agents
  async function captureAgentSessions() {
    const cwd = process.cwd();
    const assignedIds = new Set();

    // Sort agents by spawnedAt so earlier agents get first pick
    const agents = session.getAllAgents().sort((a, b) => (a.spawnedAt || 0) - (b.spawnedAt || 0));

    for (const agent of agents) {
      if (agent.spawnedAt) {
        try {
          const sessionId = await findLatestSession(agent.type, cwd, agent.spawnedAt, assignedIds);
          if (sessionId) {
            agent.agentSessionId = sessionId;
            assignedIds.add(sessionId);
          }
        } catch {
          // Ignore errors - session ID capture is best-effort
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
          cleanup();
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
        cleanup();
        if (ipcHub) ipcHub.stop();
        session.destroy();
        process.exit(0);
        break;

      case 'e':
      case 'edit': {
        // :e [agent] [extra-args...] - new tab with agent (default: claude)
        const agentType = resolveAgentType(args[0]);
        if (agentType) {
          const extraArgs = args.slice(1);  // Additional CLI args like --continue
          handleAction({ action: 'new_tab', agentType, extraArgs });
        }
        break;
      }

      case 'sp':
      case 'split': {
        // :sp [agent] [extra-args...] - horizontal split (default: claude)
        const agentType = resolveAgentType(args[0]);
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
        const agentType = resolveAgentType(args[0]);
        if (agentType) {
          const extraArgs = args.slice(1);
          handleAction({ action: 'split_vertical', agentType, extraArgs });
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
          return session.save();
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
          return session.save();
        }).then(() => {
          cleanup();
          if (ipcHub) ipcHub.stop();
          session.destroy();
          process.exit(0);
        }).catch(() => {
          cleanup();
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
    if (agent && !agent.pty) {
      // If restoring a session, rebuild args from AGENT_TYPES + resume args
      // Don't use saved agent.args - they may contain old resume args
      // Also inject FIPA reminder prompt
      if (restoredSession) {
        const typeConfig = AGENT_TYPES[agent.type];
        if (typeConfig) {
          const baseArgs = typeConfig.args || [];
          const resumeArgs = typeConfig.getResumeArgs?.(agent.agentSessionId) || [];
          const combinedArgs = [...baseArgs, ...resumeArgs];
          const fipaArgs = getFIPAPromptArgs(agent.type, combinedArgs);
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

    // Connect data handler to scheduleDraw for proper throttled rendering
    agent.pty.onData(() => compositor.scheduleDraw());

    agent.pty.onExit(({ exitCode }) => {
      // Find and close the pane for this agent
      const pane = layoutManager.findPaneByAgent(agent.id);
      if (pane) {
        // Focus this pane first so closePane() closes the right one
        layoutManager.focusPane(pane.id);

        const allPanes = layoutManager.getAllPanes();
        if (allPanes.length === 1) {
          // Last pane - quit entirely
          cleanup();
          if (ipcHub) ipcHub.stop();
          session.destroy();
          process.exit(exitCode);
        } else {
          // Close just this pane
          layoutManager.closePane();
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
    const fipaArgs = getFIPAPromptArgs(type, baseArgs);
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

  // Handle input actions from InputRouter
  function handleAction(result) {
    const focusedPane = layoutManager.getFocusedPane();
    const focusedAgent = focusedPane ? session.getAgent(focusedPane.agentId) : null;

    switch (result.action) {
      // Mode changes
      case 'mode_change':
        if (result.mode === 'normal' && focusedAgent) {
          // Initialize normal cursor to agent's cursor position
          const buffer = focusedAgent.getBuffer();
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

      // Layout navigation
      case 'focus_direction':
        layoutManager.focusDirection(result.dir);
        break;

      case 'focus_next':
        layoutManager.cycleFocus(true);
        break;

      case 'focus_prev':
        layoutManager.cycleFocus(false);
        break;

      // Split operations
      case 'split_horizontal': {
        const agentType = result.agentType || 'claude';
        const extraArgs = result.extraArgs || [];
        const newAgent = createNewAgent(agentType, extraArgs);
        const newPane = layoutManager.splitHorizontal(newAgent.id);
        if (newPane) {
          newAgent.spawn(newPane.bounds.width, newPane.bounds.height);
          setupAgentHandlers(newAgent);
        }
        handleResize();
        break;
      }

      case 'split_vertical': {
        const agentType = result.agentType || 'claude';
        const extraArgs = result.extraArgs || [];
        const newAgent = createNewAgent(agentType, extraArgs);
        const newPane = layoutManager.splitVertical(newAgent.id);
        if (newPane) {
          newAgent.spawn(newPane.bounds.width, newPane.bounds.height);
          setupAgentHandlers(newAgent);
        }
        handleResize();
        break;
      }

      // Pane management
      case 'close_pane': {
        const paneToClose = layoutManager.getFocusedPane();
        if (paneToClose) {
          const agentToKill = session.getAgent(paneToClose.agentId);
          if (layoutManager.closePane()) {
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
        break;

      // Search actions
      case 'search_start':
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
        session.save().then(filepath => {
          // Flash message would go here
        }).catch(() => {});
        break;

      // Quit
      case 'quit_force':
        cleanup();
        if (ipcHub) ipcHub.stop();
        session.destroy();
        process.exit(0);
        break;

      case 'quit_confirm':
        // For now, just quit
        cleanup();
        if (ipcHub) ipcHub.stop();
        session.destroy();
        process.exit(0);
        break;

      // Passthrough handled directly
      case 'passthrough':
        // Already written to agent in InputRouter
        break;

      // FIPA Actions - set performative and switch to chat mode
      case 'fipa_request':
        chatState.pendingPerformative = 'request';
        inputRouter.setMode('chat');
        compositor.draw();
        break;

      case 'fipa_inform':
        chatState.pendingPerformative = 'inform';
        inputRouter.setMode('chat');
        compositor.draw();
        break;

      case 'fipa_query_if':
        chatState.pendingPerformative = 'query-if';
        inputRouter.setMode('chat');
        compositor.draw();
        break;

      case 'fipa_query_ref':
        chatState.pendingPerformative = 'query-ref';
        inputRouter.setMode('chat');
        compositor.draw();
        break;

      case 'fipa_cfp':
        chatState.pendingPerformative = 'cfp';
        inputRouter.setMode('chat');
        compositor.draw();
        break;

      case 'fipa_propose':
        chatState.pendingPerformative = 'propose';
        inputRouter.setMode('chat');
        compositor.draw();
        break;

      case 'fipa_agree':
        chatState.pendingPerformative = 'agree';
        inputRouter.setMode('chat');
        compositor.draw();
        break;

      case 'fipa_refuse':
        chatState.pendingPerformative = 'refuse';
        inputRouter.setMode('chat');
        compositor.draw();
        break;

      case 'fipa_subscribe':
        chatState.pendingPerformative = 'subscribe';
        inputRouter.setMode('chat');
        compositor.draw();
        break;

      // Chat mode actions
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
          text = extractSelectedText(focusedAgent);
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

    // Route input
    const result = inputRouter.handle(str);
    handleAction(result);
  });

  // Render on agent output - use scheduleDraw for throttled drawing (like index.js)
  for (const agent of session.getAllAgents()) {
    if (agent.pty) {
      agent.pty.onData(() => compositor.scheduleDraw());
    }
  }

  // Initial render (immediate)
  compositor.draw();

  // Periodic refresh for cursor blink / idle updates
  setInterval(() => compositor.scheduleDraw(), 100);

  // Signal handlers
  process.on('SIGINT', () => {
    cleanup();
    if (mcpServer) mcpServer.stop();
    if (ipcHub) ipcHub.stop();
    if (fipaHub) fipaHub.shutdown();
    session.destroy();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    cleanup();
    if (mcpServer) mcpServer.stop();
    if (ipcHub) ipcHub.stop();
    if (fipaHub) fipaHub.shutdown();
    session.destroy();
    process.exit(0);
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
            cleanup();
            if (ipcHub) ipcHub.stop();
            session.destroy();
            process.exit(exitCode);
          } else {
            layoutManager.closePane();
            session.removeAgent(agent.id);
            handleResize();
          }
        }
      });
    }
  }

})();
