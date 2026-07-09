/**
 * Bootstrap module - CLI parsing, agent config, splash screen, CLI discovery
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const os = require('os');

// Socket discovery paths for MCP bridge
const SOCKETS_DIR = path.join(os.homedir(), '.bukowski', 'sockets');
const SOCKET_DISCOVERY_FILE = path.join(SOCKETS_DIR, String(process.pid));
const LEGACY_SOCKET_FILE = path.join(os.homedir(), '.bukowski-mcp-socket');

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
const FIPA_REMINDER = `You are running inside bukowski, a multi-agent terminal. Other AI agents may run alongside you — on this machine and on federated peer machines. Three MCP surfaces let you work with them. Use them; don't reinvent coordination over the PTY.

1. MESSAGING (FIPA) — talk to another agent.
   - Discover: list_agents. It returns each agent's id and source. Address a peer by that id: an agent in YOUR instance is "claude-1"/"codex-2" (its session id); an agent on another machine is its federated id "claude-<host>-1". Either form from list_agents works.
   - Send by intent (the performative matters):
       fipa_inform  — share a fact, no reply expected ("pushed fix X", "broker is up").
       fipa_request — ask the agent to DO something (expects a reply).
       fipa_query_if  — ask a yes/no question.   fipa_query_ref — ask for a specific value.
       fipa_propose/agree/refuse/cfp — negotiation.
   - Pass conversationId to keep a reply in the same thread (the tool result returns one).
   - Receive: messages QUEUE for you. get_pending_messages drains them. You'll usually be nudged — an out-of-turn <channel> block, or a Stop-hook reason at turn end — but you can poll anytime. Reply with the fipa_* tools.
   - Use messages for ARGUMENTS WITH EVIDENCE (a verdict with line numbers, a request with rationale). For durable state use the dashboard; for bare status facts use events.

2. DASHBOARD (dashboard_*) — a shared, cross-machine project board. Durable state, not chat: goals, roadmap, and work entries (tasks/bugs/todos/challenges/nicetohaves/adrs/tips).
   - Read: dashboard_list_projects; dashboard_digest{projectId} for a compact overview; dashboard_query{projectId, ...} to list entries (filter by repo/category/state/tag/q, or entryId for one entry in full).
   - Write your own work: dashboard_set_entry{projectId, repo, category, oneliner, refs}. You may write entries for a repo you are RESIDENT on — any agent on the same host as the repo's owner co-curates it (box-mates share edit rights); to change a repo on another host, fipa_request its residents. One-liner ≤80 chars; actionable categories need ≥1 grounding ref (sha/pr/file/conv). Entries are POINTERS, not prose — the detail lives in the ref'd artifact.
   - tips is the exception + the how-to surface: a wikihow-style gotcha/runbook entry that DOES carry a body (≤1500 chars) plus tags, with refs pointing at the canonical doc. Write with dashboard_set_entry{category:"tips", body, tags, refs}; find with dashboard_query{category:"tips", tag} or {q:"keyword"}; read one in full with {entryId}.
   - Also: dashboard_close_entry, dashboard_comment_entry, dashboard_promote, dashboard_link, dashboard_set_goal/roadmap (curator-only). Curator can dashboard_add_participant{projectId, agentId} / dashboard_remove_participant to grant comment/vote rights directly — use this to reach a co-tenant agent that shares a checkout root with another (so repo derivation can't see it separately) or a cross-host guest; grants persist across map_repos. Mutations auto-notify the relevant participants.

3. EVENTS (event_*) — subscribeable coordination FACTS with timestamps ("task-3 closed", "deploy up", "commit pushed"). Separate from messages: events NEVER block your stop-hook.
   - Publish: event_publish{topic, payload}. topic is "kind[:scope]:name" (2-4 colon segments, free-form, no registration), payload is any JSON fact ≤4096 bytes (link bigger artifacts, don't inline). Conventions: repo:<name>:commits, deploy:<name>:lifecycle, agent:<id>:status, dashboard:<project>:entries. Returns a subscriber count + a warning if nobody listens.
   - Subscribe: event_subscribe{pattern} ("*" is one segment, trailing "*" the rest — e.g. "dashboard:<project>:entries", "deploy:*:lifecycle") — returns the retained backlog inline, so you're caught up immediately.
   - event_poll drains your pending events (the authoritative path; an idle subscriber also gets a non-blocking nudge). event_topics lists what exists / who listens.
   - Dashboard mutations AUTO-publish to dashboard:<project>:entries — subscribe instead of asking "did X land yet?". Publish your own facts (a finished run, a deploy) so others can gate on them instead of polling you.
   - DO THIS when you join a piece of shared work: (a) event_subscribe to the project's stream — "dashboard:<project>:entries" plus any topics whose facts you act on (e.g. "deploy:<host>:lifecycle", "agent:<peer>:status"); a nudge only ever reaches subscribers, so an un-subscribed agent simply won't hear progress. (b) Publish your own milestones to that project's shared topics — keep facts on the COMMON kind for the work (the project's "dashboard:<project>:entries" plus the agreed "repo:<name>:commits" / "deploy:<host>:lifecycle" / "agent:<your-id>:status"), not a private topic nobody watches, so teammates can subscribe one stream and see everyone's progress. Agree the topic names with the other agents (ask via FIPA) the same way you'd agree a project's repo map.

When something is outside your expertise or owned by another repo, ask the responsible agent (list_agents to find them) rather than guessing.`;

const FIPA_REMINDER_INLINE = FIPA_REMINDER.replace(/\n+/g, '. ');

// Paths to bukowski's hook scripts for Claude Code agents. Each hook peeks
// the FIPA queue and surfaces pending messages, but they fire at different
// points in the turn lifecycle and apply different filters:
//
//   UserPromptSubmit: any pending message visible at prompt submit
//                     (additionalContext on the user turn).
//   Stop:             any pending message at turn end — block the stop with
//                     a continuation reason so Claude drains on the next turn.
//
// A PostToolUse hook used to inject pending performatives *mid-turn*, but that
// modified the open assistant turn's thinking blocks and triggered API 400
// "`thinking` blocks ... cannot be modified" errors under interleaved thinking.
// It is no longer registered (see mcp/hooks/posttool-use.js); the Stop hook
// already peeks every performative at the safe turn boundary, so delivery is
// intact — only sub-turn latency is given up.
//
// Resolved once at module load; passed via --settings JSON so each spawned
// Claude agent gets event-driven delivery without PTY-injected text.
const FIPA_CLAUDE_USERPROMPT_HOOK = path.resolve(__dirname, '..', 'mcp', 'hooks', 'userprompt-submit.js');
const FIPA_CLAUDE_STOP_HOOK = path.resolve(__dirname, '..', 'mcp', 'hooks', 'stop.js');
const FIPA_CLAUDE_SETTINGS_JSON = JSON.stringify({
  hooks: {
    UserPromptSubmit: [
      {
        hooks: [
          { type: 'command', command: `node ${FIPA_CLAUDE_USERPROMPT_HOOK}` }
        ]
      }
    ],
    Stop: [
      {
        hooks: [
          { type: 'command', command: `node ${FIPA_CLAUDE_STOP_HOOK}` }
        ]
      }
    ]
  }
});

// Whether Claude Code channels are enabled for spawned claude agents.
// On by default; BUKOWSKI_NO_CHANNELS=1 (or "true") falls back to the
// PTY/Stop-hook delivery path only. Shared by the launch args and the
// FIPA delivery code so the PTY nudge isn't sent redundantly when the
// channel push already wakes the agent.
function channelsEnabled() {
  const v = process.env.BUKOWSKI_NO_CHANNELS;
  return v !== '1' && v !== 'true';
}

// Create agent type configurations
function createAgentTypes(claudePath, codexPath) {
  const claudeEntrypointExists = claudePath && claudePath !== 'claude' && fs.existsSync(claudePath);
  const claudeCommand = claudeEntrypointExists ? 'node' : 'claude';
  const claudeArgs = claudeEntrypointExists ? [claudePath] : [];
  const claudeHookArgs = (
    fs.existsSync(FIPA_CLAUDE_USERPROMPT_HOOK) &&
    fs.existsSync(FIPA_CLAUDE_STOP_HOOK)
  ) ? ['--settings', FIPA_CLAUDE_SETTINGS_JSON] : [];

  // Claude Code "channels": opt the spawned agent into the bukowski channel so
  // the MCP server can push notifications/claude/channel events that inject the
  // message out-of-turn as a <channel> block — no PTY keystroke. Preferred is
  // the QUIET plugin form `--channels plugin:bukowski-channel@bukowski` (no
  // per-launch notice). That only registers if the plugin is on the effective
  // channel allowlist — which for a custom plugin means `allowedChannelPlugins`
  // in /etc/claude-code/managed-settings.json (a managed-tier key; not honored
  // in ~/.claude/settings.json). channelPluginRef() returns the ref when the
  // plugin is enabled; if it isn't set up we fall back to the research-preview
  // `--dangerously-load-development-channels server:bukowski` (loads the bare
  // connection as the channel — works, but prints a notice each launch).
  // BUKOWSKI_NO_CHANNELS=1 disables channels entirely (PTY/Stop-hook delivery).
  let channelArgs = [];
  if (channelsEnabled()) {
    let pluginRef = null;
    try { pluginRef = require('../mcp/install').channelPluginRef(); } catch { /* fall back */ }
    channelArgs = pluginRef
      ? ['--channels', pluginRef]
      : ['--dangerously-load-development-channels', 'server:bukowski'];
  }

  return {
    claude: {
      command: claudeCommand,
      args: [...claudeArgs, ...claudeHookArgs, ...channelArgs],
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
  // Virtual pane types — not PTY-backed agents in AGENT_TYPES, but valid
  // `:split` targets (the split handler routes them to their pane factory).
  if (type === 'chat' || type === 'dashboard') return type;
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
    join: null,
    ugly: false,
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
    } else if (arg === '--join' || arg === '-j') {
      // Join a remote bukowski's federation over SSH: forward fed sockets
      // both ways and register static peers so the two mesh across the net.
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith('-')) {
        result.join = nextArg;
        i++;
      }
    } else if (arg === '--ugly') {
      // Constrained-terminal mode: collapse emoji clusters to BMP-safe "··"
      // placeholders so old emulators (ConnectBot on Android) don't crash their
      // VT parser on Claude's astral/ZWJ emoji. Same as BUKOWSKI_BMP_ONLY=1.
      result.ugly = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`bukowski - multi-agent terminal

Usage: bukowski [options] [-- agent-args...]

Options:
  -1, --single             Single-pane mode (legacy, no splits)
  -r, --restore [id|name]  Restore a saved session (default: latest)
      --resume             Alias for --restore
  -s, --session <name>     Set session name
  -j, --join <endpoint>    Federate with a remote bukowski over SSH
                           (e.g. user@host:2222 or an ssh_config alias)
      --ugly               BMP-safe rendering: collapse emoji to "··" so old
                           terminals (ConnectBot) don't crash on astral/ZWJ
                           emoji. Same as BUKOWSKI_BMP_ONLY=1.
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
    } else if (arg === '--debug-enable-compensations') {
      // Bukowski-only flag, don't pass to agents (handled by Compositor)
      continue;
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
  SOCKETS_DIR,
  SOCKET_DISCOVERY_FILE,
  LEGACY_SOCKET_FILE,
  FIPA_REMINDER,
  FIPA_REMINDER_INLINE,

  // CLI discovery
  findClaudePath,
  findCodexPath,

  // Agent config
  createAgentTypes,
  getFIPAPromptArgs,
  resolveAgentType,
  channelsEnabled,

  // Splash
  loadQuotes,
  showSplash,

  // CLI parsing
  parseArgs
};
