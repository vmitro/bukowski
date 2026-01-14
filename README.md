![demo](demo.gif)

## Overview

Terminal multiplexer for AI coding agents (Claude, Codex, Gemini). Runs multiple agents in split panes with unified input routing and FIPA ACL inter-agent communication.

Agent output is captured into virtual terminal buffers rather than written directly to stdout. The compositor extracts only visible lines and renders the entire frame in a single DEC 2026 synchronized update. This eliminates scrollback pollution from high-volume agent output - the terminal only sees final composited frames, not thousands of intermediate render states.

## Install

```bash
npm install
npm link  # optional, makes `bukowski` available globally
```

## Usage

```bash
node multi.js          # or `bukowski` if linked
bukowski --session myproject      # name this session "myproject"
bukowski --resume myproject       # resume existing session "myproject"
```

**Session flags**:
- `--session <name>` - Names the current session (creates new if doesn't exist)
- `--resume <name>` - Resumes an existing session with its full conversation history

## MCP Server Setup

Each agent needs the bukowski MCP server configured to enable inter-agent FIPA messaging.

**Automatic installation**:
```bash
node -e "require('./src/mcp/install').installAll()"
```

**Check status**:
```bash
node -e "console.log(require('./src/mcp/install').checkStatus())"
```

**Uninstall**:
```bash
node -e "require('./src/mcp/install').uninstallAll()"
```

The install script configures:
- Claude Code (`~/.claude.json`)
- Codex (`~/.codex/config.toml`)
- Gemini (`~/.gemini/settings.json`)

The MCP bridge auto-detects the socket path via `BUKOWSKI_MCP_SOCKET` environment variable set by the parent bukowski process.

**Input modes**: insert (default), normal, visual, search, command, chat
**Prefix key**: `Ctrl+Space` followed by:
- `w` - layout operations (split, resize, zoom, close)
- `a` - IPC operations
- `f` - FIPA ACL messaging
- `c` - chat mode (full-screen inter-agent messaging)

**Navigation**: vim-style (`hjkl`, `gg`, `G`, `/` search)
**Mouse**: scroll wheel, `Ctrl+scroll` vertical resize, `Alt+scroll` horizontal resize

**Runtime tuning** (ex command):
` :set output_silence=32 ` (applies immediately)
` :set scrollback=2000 ` (applies to newly spawned agents)

## Environment overrides

- `BUKOWSKI_SESSION` - default session name (overrides `--session`)
- `BUKOWSKI_SPLASH` - splash screen duration in ms (default: 2000)
- `BUKOWSKI_OUTPUT_SILENCE_DURATION` - PTY output debounce in ms (default: 16)
- `BUKOWSKI_ROWS` - virtual terminal rows per pane (default: pane height)
- `BUKOWSKI_SCROLLBACK` - scrollback lines per agent (default: 10000)
- `BUKOWSKI_MCP_SOCKET` - override MCP socket path for the bridge

## Limitations

- OSC 10/11 queries don't work through PTY intermediaries (affects Codex input box styling)
- Final terminal row reserved for status bar
- `:help` shows status hint, not full help dialog

## License

Source-available, pay-what-you-want ($10 suggested). Free for open source development.
See [LICENSE](LICENSE) for details.

[Website](https://bukowski.store/)
