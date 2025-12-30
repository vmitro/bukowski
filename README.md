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
```

**Input modes**: insert (default), normal, visual, search, command, chat
**Prefix key**: `Ctrl+Space` followed by:
- `w` - layout operations (split, resize, zoom, close)
- `a` - IPC operations
- `f` - FIPA ACL messaging
- `c` - chat mode (full-screen inter-agent messaging)

**Navigation**: vim-style (`hjkl`, `gg`, `G`, `/` search)
**Mouse**: scroll wheel, `Ctrl+scroll` vertical resize, `Alt+scroll` horizontal resize

## Limitations

- OSC 10/11 queries don't work through PTY intermediaries (affects Codex input box styling)
- Final terminal row reserved for status bar
- `:help` shows status hint, not full help dialog

## License

Source-available, pay-what-you-want ($10 suggested). Free for open source development.
See [LICENSE](LICENSE) for details.

[Website](https://bukowski.store/)
