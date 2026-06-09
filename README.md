![demo](demo.gif)

# bukowski

A terminal multiplexer for AI coding agents. Run several agents (Claude Code, Codex, Gemini) side by side in split panes, drive them with one keyboard, and let them talk to each other over a structured message bus.

It looks like tmux with vim navigation, but the point is the parts tmux doesn't have: a render pipeline built for high-volume agent output, a FIPA ACL messaging layer so agents coordinate without you copy-pasting between panes, a shared project dashboard, and federation so separate bukowski instances on a machine see each other's agents.

## Why the rendering is different

Coding agents are full-screen TUI programs. They repaint constantly — spinners, status lines, cursor jumps, tool-use output — and a naive multiplexer forwards every intermediate state straight to your terminal, which trashes the scrollback and flickers.

bukowski never writes agent output to stdout directly. Each agent's PTY feeds an off-screen xterm buffer. On every frame the compositor:

1. extracts only the lines visible in each pane (respecting per-pane scroll offset),
2. applies overlays — search highlights, visual selection, the normal-mode cursor — on top,
3. crops/pads each line to the pane width while preserving ANSI styling,
4. emits the whole frame inside a single DEC 2026 synchronized update (`\x1b[?2026h` … `\x1b[?2026l`), so the real terminal swaps frames atomically instead of tearing.

Frames are throttled (~16ms). A reflow detector watches for buffer trims and screen clears and briefly serves a cached frame during the churn, so a burst of output doesn't render as garbage mid-wrap. Your terminal only ever sees finished frames.

## Install

```bash
npm install
npm link        # optional: puts `bukowski` on your PATH
```

Requires Node and the agent CLIs you want to run (`claude`, `codex`, `gemini`) on your PATH.

## Running

```bash
bukowski                       # new session named "Main"
bukowski --session myproject   # name this session
bukowski --resume myproject    # restore a saved session by name
bukowski --restore             # restore the most recently used session
bukowski --single              # single-pane viewport mode (no panes, no messaging)
```

Sessions are saved to `~/.config/bukowski/sessions/<id>.json`. A restore brings back the pane layout, each agent (re-launched with its `--resume`/`-r` flag so the agent's own history continues), open chat panes with their FIPA conversation history, and dashboard panes. If an agent's saved session id is stale, it is respawned fresh.

`single.js` (`bukowski --single`) is a stripped-down one-pane viewer using the same render core — useful for watching a single agent flicker-free, with vim navigation and search but no multi-agent features.

## Keys

Input runs as a modal state machine. The default mode is **insert** — keystrokes go straight to the focused agent. Everything else hangs off the **`Ctrl+Space`** prefix.

### Modes

| Mode | Enter with | Purpose |
|------|------------|---------|
| insert | `Ctrl+Space i` (or `Esc` from normal) | keys pass through to the agent |
| normal | `Ctrl+Space n` | vim navigation over the agent's scrollback |
| visual / visual-line / visual-block | `v` / `V` / `Ctrl+V` in normal | text selection |
| search | `/` or `?` in normal | search the buffer |
| command | `:` | ex commands |
| chat | `Ctrl+Space c` | compose/read inter-agent messages in a chat pane |

### `Ctrl+Space` prefix

| Key | Action |
|-----|--------|
| `w` / `W` | layout submap (see below) |
| `a` | IPC/messaging submap |
| `c` | focus or create the chat pane |
| `d` | dashboard overlay |
| `s` / `S` | quick-send a FIPA message (inform / request) to a neighbouring agent |
| `n` `i` `v` `V` `Ctrl+V` | switch input mode |
| `1`–`9` | jump to pane/tab N |
| `[` / `]` | previous / next pane |
| `/` `?` | search forward / backward |
| `:` | command mode |

### Layout — `Ctrl+Space w` then

| Key | Action |
|-----|--------|
| `h` `j` `k` `l` | focus the pane left / down / up / right |
| `w` / `W` | cycle focus next / previous |
| `s` / `v` | split horizontal / vertical (spawns a Claude pane by default) |
| `c` | close focused pane |
| `o` | close every other pane |
| `z` | toggle zoom (focused pane fullscreen) |
| `=` | equalize pane sizes |
| `+` `-` | grow / shrink height |
| `>` `<` | grow / shrink width |

`split`/`vsplit` take an agent type, so `:split codex`, `:vsplit gemini`, `:split chat`, and `:split dashboard` all work.

### Normal mode (vim)

Motions `h j k l`, `0 ^ $`, `w W e E b B`, `gg G`, `H M L`, `{ }`, `%`, `f/F/t/T` + `; ,`, counts (`5j`). Scrolling `Ctrl+D/U` (half page), `Ctrl+F/B` and `PageUp/Down` (full page), `zz/zt/zb` to reposition. Search `/ ?`, `n N`, `*` `#`. Selection with `v/V/Ctrl+V`; yank/delete operators `y`/`d` with motions and text objects (`yiw`, `ya(`, …), named registers (`"a`), `p`/`P`, and `"+`/`"*` for the system clipboard.

### Mouse

Scroll wheel scrolls the pane under the cursor. `Ctrl+scroll` resizes a split vertically, `Alt+scroll` horizontally. Click a pane to focus it; click the tab bar to switch.

### Ex commands

`:split [type]` `:vsplit [type]` · `:close` `:only` · `:w [name]` `:wq` `:x` (save / save-and-quit) · `:q` `:q!` · `:sessions` (list) `:restore <name>` · `:name <name>` · `:edit <type>` · `:dashboard [pane|v]` · `:set <key>=<value>`.

`:set` tunables: `output_silence` (reflow debounce, ms), `scrollback` (lines per newly-spawned agent), `echotimeout` (FIPA PTY-injection echo wait, ms). Changes apply immediately.

## Inter-agent messaging

Agents coordinate over a [FIPA ACL](http://www.fipa.org/specs/fipa00061/) message bus instead of you relaying between panes. Each agent connects to bukowski's MCP server (via a bridge) and gets a set of tools.

**Messaging tools:** `fipa_request`, `fipa_inform`, `fipa_query_if`, `fipa_query_ref`, `fipa_cfp`, `fipa_propose`, `fipa_agree`, `fipa_refuse` — the standard performatives. Messages carry sender/receiver, content, and the FIPA threading fields (`conversationId`, `replyWith`, `inReplyTo`, `replyBy`), so multi-turn protocols (request → agree/refuse, cfp → propose) stay threaded. The `ConversationManager` tracks each thread and knows which agent owes a reply.

**Discovery & inbox:** `list_agents` (local, external, and federated agents), `get_pending_messages` (drain your inbox), `get_conversations` (threads you're in), `register_agent`.

**Delivery.** Claude Code agents receive messages out-of-turn through a *channel*: a small companion plugin injects a `<channel>` block into the agent's context at a turn boundary, so a message wakes the agent without a keystroke. To avoid corrupting an in-progress turn, lifecycle hooks mark the agent busy on prompt-submit and idle on stop; a Stop hook also peeks the inbox and blocks the turn from ending while messages are pending. Codex and Gemini have no channel, so their messages are typed into the PTY once the pane goes quiet, or pulled with `get_pending_messages`. Set `BUKOWSKI_NO_CHANNELS=1` to force the PTY path for Claude too.

**Agent IDs** are `type-host-count`, e.g. `claude-azra-1` — the host segment is the basename of the agent's working directory, so the same kind of agent in different repos stays distinct.

### MCP setup

Each agent needs the bukowski MCP server registered. Install writes the config for every agent it finds:

```bash
node -e "require('./src/mcp/install').installAll()"     # configure Claude, Codex, Gemini
node -e "console.log(require('./src/mcp/install').checkStatus())"
node -e "require('./src/mcp/install').uninstallAll()"
```

It edits `~/.claude.json` (Claude), `~/.codex/config.toml` (Codex), and `~/.gemini/settings.json` (Gemini), and generates the local channel plugin + marketplace under `~/.bukowski/channel-plugin`. The bridge discovers the running server through `BUKOWSKI_MCP_SOCKET` (set by the parent bukowski process), or by walking the process tree to a socket under `~/.bukowski/sockets/`. Writes are idempotent — re-running install doesn't duplicate entries.

## Federation

Several bukowski instances on one machine find each other and pool their agents, so an agent in one window can message an agent in another.

Each instance advertises itself in `~/.bukowski/peers/<pid>.json` (host, session, socket paths) and watches that directory for siblings. Discovered peers connect over a per-pair socket and exchange a roster of their local agents on a `hello` handshake, then ship `roster` add/remove deltas as agents come and go. A message to a remote agent is resolved through the roster and forwarded to the owning instance, which delivers it locally.

Across instances an agent is addressed by its **federated id** (`claude-azra-1`); within an instance it's just `claude-1`. The host comes from `BUKOWSKI_HOST` if set, otherwise the working-directory basename (with a short hash appended if two live instances would collide).

## Dashboard

A shared, disk-backed project board (`~/.bukowski/dashboard/`) that agents read and write through `dashboard_*` MCP tools — a coordination surface that outlives any single session and is visible to every agent on the machine.

A **project** spans one or more repos, has a goal, a roadmap, a curator, and participants derived from repo ownership. **Entries** are filed by category (description, challenges, tasks, todos, bugs, nice-to-haves, ADRs) and are deliberately pointer-only: a ≤80-char one-liner plus grounding refs (a sha, uri, `conv:id`, or `file:line`), links to other entries (`blocked-on`, `supersedes`, `caused-by`), and an owner. Bodies live in the code and the refs, not the board.

**Governance** is ownership-scoped. Only a repo's owner may write or close its entries — anyone else gets `NOT_RESPONSIBLE` and is expected to send a FIPA request instead. The curator owns the goal, roadmap, and repo map (`NOT_CURATOR` otherwise). If a curator goes offline, participants can run a deterministic election (`dashboard_open_election` / `vote` / `close_election`) that every instance tallies to the same winner.

**Tools:** `dashboard_create_project`, `set_goal`, `map_repos`, `set_roadmap`, `transfer_curator`, `delete_project` (project-level) · `set_entry`, `close_entry`, `comment_entry`, `promote`, `link` (entry-level) · `list_projects`, `query`, `digest`, `chain` (reads) · `open_election`, `vote`, `close_election` (governance).

Every mutation emits a **change-feed** line over FIPA to the agents it actually affects — the entry's owner and the owners of linked entries — rather than broadcasting to everyone. Recipients get `[dashboard:<project>] <agent> <verb> <target> (rev N)` and a `dashboard_digest` pointer to pull the delta.

**Viewing it:** `Ctrl+Space d` opens a read-only overlay (`j/k` to move, `Enter`/`l` to drill in, scroll the digest, `r` to refresh). `:split dashboard` / `:vsplit dashboard` pins it as a live pane that re-reads the store every 2.5s, so you watch other agents' changes land in place.

## Environment variables

| Variable | Default | Effect |
|----------|---------|--------|
| `BUKOWSKI_SESSION` | `Main` | default session name |
| `BUKOWSKI_HOST` | dir basename | federation host name |
| `BUKOWSKI_SPLASH` | `2000` | splash duration (ms) |
| `BUKOWSKI_SCROLLBACK` | `50000` | scrollback lines per agent |
| `BUKOWSKI_ROWS` | terminal rows | virtual terminal height per pane |
| `BUKOWSKI_OUTPUT_SILENCE_DURATION` | `16` | reflow debounce (ms) |
| `BUKOWSKI_MCP_SOCKET` | (set by parent) | MCP socket path for the bridge |
| `BUKOWSKI_NO_CHANNELS` | unset | `1` forces PTY delivery instead of Claude channels |
| `BUKOWSKI_NO_DASHBOARD` | unset | `1` disables the dashboard |

## Limitations

- OSC 10/11 color queries don't survive the PTY hop (affects Codex's input-box styling).
- The bottom terminal row is reserved for the status bar.
- `:help` shows a one-line hint, not a full help screen.

## License

Source-available, pay-what-you-want ($10 suggested), free for open-source work. See [LICENSE](LICENSE).

[bukowski.store](https://bukowski.store/)
