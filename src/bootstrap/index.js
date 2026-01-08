/**
 * Bootstrap module - CLI parsing, agent config, splash screen, CLI discovery
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const os = require('os');

// Socket discovery file for MCP bridge (per-process to isolate sessions)
const SOCKET_DISCOVERY_FILE = path.join(os.homedir(), `.bukowski-mcp-socket-${process.pid}`);

// Load quotes from quotes.txt
function loadQuotes(quotesPath) {
  try {
    const raw = fs.readFileSync(quotesPath, 'utf8');
    return raw.split(/\n\n+/).filter(Boolean).map(block => {
      const lines = block.trim().split('\n');
      const author = lines.pop().replace(/^—\s*/, '');
      const text = lines.join(' ');
      return { text, author };
    });
  } catch {
    return [{ text: "Let there be light.", author: "bukowski" }];
  }
}

// Show splash screen with random quote
function showSplash(quotes) {
  const QUOTES = quotes || [{ text: "Let there be light.", author: "bukowski" }];
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

// Find Claude CLI path
function findClaudePath() {
  try {
    const claudeBin = execSync('readlink -f "$(which claude)"', { encoding: 'utf8' }).trim();
    const claudeDir = path.dirname(claudeBin);
    return path.join(claudeDir, 'cli.js');
  } catch {
    return 'claude'; // Fallback
  }
}

// Find Codex CLI path
function findCodexPath() {
  try {
    const codexBin = execSync('readlink -f "$(which codex)"', { encoding: 'utf8' }).trim();
    return codexBin;
  } catch {
    return null; // Not installed
  }
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

const FIPA_REMINDER_INLINE = FIPA_REMINDER.replace(/\n+/g, '. ');

// Create agent type configurations
function createAgentTypes(claudePath, codexPath) {
  return {
    claude: {
      command: 'node',
      args: [claudePath],
      name: 'Claude',
      promptFlag: '--append-system-prompt',
      getResumeArgs: (sessionId) => sessionId
        ? ['--resume', sessionId]
        : ['--continue']
    },
    codex: {
      command: 'node',
      args: codexPath ? [codexPath] : [],
      name: 'Codex',
      promptFlag: null,
      getResumeArgs: (sessionId) => sessionId
        ? ['resume', sessionId]
        : ['resume', '--last']
    },
    gemini: {
      command: 'gemini',
      args: ['-i', FIPA_REMINDER_INLINE],
      name: 'Gemini',
      promptFlag: null,
      getResumeArgs: (sessionId) => sessionId
        ? ['-r', sessionId]
        : ['-r', 'latest']
    }
  };
}

/**
 * Get FIPA prompt args for an agent type
 * @param {Object} agentTypes - The AGENT_TYPES object
 * @param {string} agentType - Type of agent
 * @param {string[]} existingArgs - Existing args
 * @returns {string[]} Args to append
 */
function getFIPAPromptArgs(agentTypes, agentType, existingArgs) {
  const config = agentTypes[agentType];
  if (!config) return [];

  if (agentType === 'gemini') {
    return [];
  }

  if (!config.promptFlag) return [];

  if (existingArgs.includes(config.promptFlag)) {
    return [];
  }

  return [config.promptFlag, FIPA_REMINDER];
}

/**
 * Resolve agent type from string argument
 * @param {Object} agentTypes - The AGENT_TYPES object
 * @param {string} arg - User input
 * @returns {string|null} Agent type or null if invalid
 */
function resolveAgentType(agentTypes, arg) {
  if (!arg) return 'claude'; // default
  const type = arg.toLowerCase();
  if (agentTypes[type] && agentTypes[type].command) {
    return type;
  }
  return null; // invalid type
}

// Parse CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    restore: null,
    sessionName: null,
    single: false,
    agentArgs: []
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--single' || arg === '-1') {
      result.single = true;
    } else if (arg === '--restore' || arg === '--resume' || arg === '-r') {
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith('-')) {
        result.restore = nextArg;
        i++;
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
  -1, --single             Single-pane mode (legacy, no splits)
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
  bukowski                           Start new session (multi-pane)
  bukowski --single                  Start single-pane mode
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

module.exports = {
  // Constants
  SOCKET_DISCOVERY_FILE,
  FIPA_REMINDER,
  FIPA_REMINDER_INLINE,

  // CLI discovery
  findClaudePath,
  findCodexPath,

  // Agent config
  createAgentTypes,
  getFIPAPromptArgs,
  resolveAgentType,

  // Splash
  loadQuotes,
  showSplash,

  // CLI parsing
  parseArgs
};
