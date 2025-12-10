# Multi-Agent Support Architecture Design

## Executive Summary

Transform bukowski from a single-agent pager into a **multi-agent orchestration terminal** with tiling window manager capabilities, powered by xterm.js viewports and inter-agent communication protocols.

---

## 1. Core Architecture Components

### 1.1 Agent Abstraction Layer

**Purpose**: Decouple agent-specific implementations from the core UI/layout system.

```
┌─────────────────────────────────────────┐
│         AgentRegistry                    │
│  - Manages all agent instances          │
│  - Lifecycle: spawn, kill, restart      │
│  - Discovery: find agents by name/type  │
└─────────────────────────────────────────┘
                    │
        ┌───────────┴───────────┐
        │                       │
┌───────▼──────┐       ┌───────▼──────┐
│ Agent        │       │ Agent        │
│ - id         │       │ - id         │
│ - name       │       │ - name       │
│ - type       │       │ - type       │
│ - pty        │       │ - pty        │
│ - terminal   │       │ - terminal   │
│ - viewport   │       │ - viewport   │
│ - status     │       │ - status     │
└──────────────┘       └──────────────┘
```

**Agent Types**:
- `claude` - Claude CLI (existing)
- `codex` - OpenAI Codex via API wrapper
- `gemini` - Google Gemini CLI
- `gpt4` - GPT-4 CLI wrapper
- `custom` - User-defined agents via config

**Agent Configuration** (`agents.json`):
```json
{
  "agents": [
    {
      "id": "claude-primary",
      "name": "Claude",
      "type": "claude",
      "command": "node",
      "args": ["/path/to/cli.js"],
      "env": { "FORCE_COLOR": "1" },
      "autostart": true
    },
    {
      "id": "codex-1",
      "name": "Codex",
      "type": "codex",
      "command": "python",
      "args": ["-m", "codex_cli"],
      "env": {},
      "autostart": false
    }
  ]
}
```

### 1.2 Layout System (Tiling Window Manager)

**Inspired by**: i3wm, tmux, Emacs windows

**Layout Tree Structure**:
```
Workspace (Tab)
    │
    ├── Container (Split: horizontal)
    │       ├── Pane (Agent: claude-primary)
    │       └── Container (Split: vertical)
    │               ├── Pane (Agent: codex-1)
    │               └── Pane (Agent: gemini-1)
    │
    └── [Status Bar]
```

**Key Classes**:

```javascript
class LayoutNode {
  // Base class for layout tree nodes
  type: 'workspace' | 'container' | 'pane';
  parent: LayoutNode | null;
  children: LayoutNode[];
  bounds: { x, y, width, height };
}

class Workspace extends LayoutNode {
  // Top-level tab (like tmux window)
  name: string;
  id: string;
  rootContainer: Container;
}

class Container extends LayoutNode {
  // Split container (like i3 container)
  orientation: 'horizontal' | 'vertical';
  ratio: number[];  // Split ratios [0.5, 0.5] for 50/50
}

class Pane extends LayoutNode {
  // Leaf node - contains agent viewport
  agent: Agent;
  viewport: Viewport;
  focused: boolean;
}

class LayoutManager {
  workspaces: Workspace[];
  activeWorkspace: Workspace;
  focusedPane: Pane;

  // Operations
  splitHorizontal(pane: Pane, newAgent: Agent): void;
  splitVertical(pane: Pane, newAgent: Agent): void;
  closePane(pane: Pane): void;
  focusNext(): void;
  focusPrevious(): void;
  focusDirection(dir: 'up'|'down'|'left'|'right'): void;
  resizePane(pane: Pane, delta: number): void;

  // Workspace/tab management
  createWorkspace(name: string): Workspace;
  switchWorkspace(id: string): void;
  closeWorkspace(id: string): void;
}
```

**Layout Algorithm**:
1. Calculate screen dimensions (columns × rows)
2. Recursively traverse layout tree
3. Allocate bounds to each node based on:
   - Parent bounds
   - Split orientation
   - Split ratios
4. Reserve space for borders/status bar
5. Assign final viewport dimensions to each pane

### 1.3 Multi-Viewport Rendering

**Challenge**: Combine multiple xterm.js buffers into single screen output.

**Compositor Architecture**:

```
┌──────────────────────────────────────────┐
│          Compositor                      │
│  - Collects frames from all viewports   │
│  - Applies layout geometry               │
│  - Draws borders/separators              │
│  - Highlights focused pane               │
│  - Renders to stdout                     │
└──────────────────────────────────────────┘
           │
     ┌─────┴─────┬─────────────┐
     │           │             │
┌────▼────┐ ┌───▼────┐  ┌─────▼────┐
│Viewport │ │Viewport│  │Viewport  │
│ Agent1  │ │ Agent2 │  │ Agent3   │
└─────────┘ └────────┘  └──────────┘
```

**Frame Building Process**:

```javascript
class Compositor {
  render() {
    const frame = new Array(screenHeight).fill(null).map(() => ' '.repeat(screenWidth));

    // 1. Traverse layout tree, draw each pane
    for (const pane of this.layout.getVisiblePanes()) {
      const { x, y, width, height } = pane.bounds;
      const lines = pane.viewport.getVisibleLines();

      for (let i = 0; i < lines.length; i++) {
        frame[y + i] = replaceSubstring(frame[y + i], x, lines[i]);
      }
    }

    // 2. Draw borders
    this.drawBorders(frame);

    // 3. Draw status bars (per-pane and global)
    this.drawStatusBars(frame);

    // 4. Highlight focused pane
    this.highlightFocused(frame);

    // 5. Output with flicker-free sync
    process.stdout.write(`\x1b[?2026h${frame.join('\n')}\x1b[?2026l`);
  }

  drawBorders(frame) {
    // Use box-drawing characters (─│┌┐└┘├┤┬┴┼)
    // Draw lines between panes based on layout tree
  }
}
```

**Border Styles**:
- Focused pane: Bold/colored border (`┃━┏┓┗┛`)
- Inactive panes: Dim border (`│─┌┐└┘`)
- Border includes pane label: `┤ Claude ├`

### 1.4 Input Routing System

**Challenge**: Route keypresses to correct destination (agent, layout, global).

**Input Flow**:

```
stdin → InputRouter → ┌─→ Global commands (Ctrl+Space)
                      ├─→ Layout commands (Ctrl+W)
                      ├─→ Tab commands (Alt+1-9)
                      ├─→ Inter-agent commands (Ctrl+A)
                      └─→ Focused agent (passthrough)
```

**Input Router**:

```javascript
class InputRouter {
  constructor(layoutManager, agentRegistry, ipcHub) {
    this.layout = layoutManager;
    this.agents = agentRegistry;
    this.ipc = ipcHub;
    this.mode = 'normal';  // 'normal' | 'command' | 'agent' | 'ipc'
  }

  handleInput(data) {
    // Priority order:

    // 1. Global escape sequences
    if (data === '\x1b') {
      this.mode = 'normal';
      return;
    }

    // 2. Command mode (Ctrl+Space)
    if (data === '\x00') {  // Ctrl+Space
      this.mode = 'command';
      return;
    }

    // 3. Command mode active
    if (this.mode === 'command') {
      this.handleCommandMode(data);
      return;
    }

    // 4. Layout manipulation (Ctrl+W prefix)
    if (this.layoutPrefix && this.handleLayoutCommand(data)) {
      return;
    }

    if (data === '\x17') {  // Ctrl+W
      this.layoutPrefix = true;
      return;
    }

    // 5. Tab switching (Alt+1-9)
    if (data.match(/\x1b[1-9]/)) {
      const tabNum = parseInt(data[1]);
      this.layout.switchWorkspace(tabNum - 1);
      return;
    }

    // 6. Inter-agent communication (Ctrl+A prefix)
    if (this.ipcPrefix && this.handleIPCCommand(data)) {
      return;
    }

    if (data === '\x01') {  // Ctrl+A
      this.ipcPrefix = true;
      return;
    }

    // 7. Pass to focused agent
    const focusedPane = this.layout.focusedPane;
    if (focusedPane && focusedPane.agent) {
      focusedPane.agent.pty.write(data);
    }
  }

  handleLayoutCommand(key) {
    switch (key) {
      case 'h': this.layout.focusDirection('left'); return true;
      case 'j': this.layout.focusDirection('down'); return true;
      case 'k': this.layout.focusDirection('up'); return true;
      case 'l': this.layout.focusDirection('right'); return true;
      case 's': this.layout.splitHorizontal(); return true;
      case 'v': this.layout.splitVertical(); return true;
      case 'c': this.layout.closePane(); return true;
      case 'o': this.layout.focusOnly(); return true;
      case '=': this.layout.equalizeRatios(); return true;
      case '+': this.layout.resizeFocused(+5); return true;
      case '-': this.layout.resizeFocused(-5); return true;
      default: return false;
    }
  }
}
```

**Key Bindings**:

| Prefix      | Key | Action                              |
|-------------|-----|-------------------------------------|
| `Ctrl+Space`| -   | Enter command mode (show menu)      |
| `Alt`       | 1-9 | Switch to workspace/tab N           |
| `Ctrl+W`    | h/j/k/l | Focus pane in direction         |
| `Ctrl+W`    | s   | Split horizontal                    |
| `Ctrl+W`    | v   | Split vertical                      |
| `Ctrl+W`    | c   | Close focused pane                  |
| `Ctrl+W`    | o   | Close all except focused            |
| `Ctrl+W`    | =   | Equalize split ratios               |
| `Ctrl+W`    | +/- | Resize focused pane                 |
| `Ctrl+A`    | -   | Enter inter-agent command mode      |

---

## 2. Inter-Agent Communication (IPC)

### 2.1 Message Protocol

**Design Goals**:
- Language-agnostic (JSON-based)
- Support sync (request/response) and async (broadcast/chat)
- Type-safe message structure
- Routing by agent ID or broadcast

**Message Structure**:

```json
{
  "id": "msg-uuid-1234",
  "timestamp": 1234567890,
  "from": "claude-primary",
  "to": "codex-1",  // or "*" for broadcast
  "type": "request" | "response" | "broadcast" | "event",
  "method": "execute_code" | "review_code" | "chat" | "...",
  "payload": {
    // Method-specific data
  },
  "replyTo": "msg-uuid-5678"  // For responses
}
```

**Message Types**:

1. **Request/Response (Synchronous)**:
   ```json
   // Request
   {
     "type": "request",
     "from": "claude-primary",
     "to": "codex-1",
     "method": "execute_code",
     "payload": {
       "language": "python",
       "code": "print('hello')",
       "timeout": 5000
     }
   }

   // Response
   {
     "type": "response",
     "from": "codex-1",
     "to": "claude-primary",
     "replyTo": "msg-uuid-1234",
     "payload": {
       "stdout": "hello\n",
       "stderr": "",
       "exitCode": 0
     }
   }
   ```

2. **Broadcast (Asynchronous)**:
   ```json
   {
     "type": "broadcast",
     "from": "claude-primary",
     "to": "*",
     "method": "chat",
     "payload": {
       "message": "I need help debugging this function",
       "context": {
         "file": "index.js",
         "line": 123
       }
     }
   }
   ```

3. **Event (Fire-and-forget)**:
   ```json
   {
     "type": "event",
     "from": "codex-1",
     "to": "*",
     "method": "status_change",
     "payload": {
       "status": "busy",
       "task": "Running tests"
     }
   }
   ```

### 2.2 IPC Hub Architecture

```javascript
class IPCHub extends EventEmitter {
  constructor(agentRegistry) {
    this.agents = agentRegistry;
    this.messageQueue = [];
    this.pendingRequests = new Map();  // id -> { resolve, reject, timeout }
  }

  // Synchronous: request/response pattern
  async sendRequest(from, to, method, payload, timeout = 30000) {
    const message = {
      id: uuidv4(),
      timestamp: Date.now(),
      from,
      to,
      type: 'request',
      method,
      payload
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(message.id, { resolve, reject });

      this.routeMessage(message);

      setTimeout(() => {
        if (this.pendingRequests.has(message.id)) {
          this.pendingRequests.delete(message.id);
          reject(new Error('Request timeout'));
        }
      }, timeout);
    });
  }

  // Handle response
  handleResponse(message) {
    const pending = this.pendingRequests.get(message.replyTo);
    if (pending) {
      pending.resolve(message.payload);
      this.pendingRequests.delete(message.replyTo);
    }
  }

  // Asynchronous: broadcast
  broadcast(from, method, payload) {
    const message = {
      id: uuidv4(),
      timestamp: Date.now(),
      from,
      to: '*',
      type: 'broadcast',
      method,
      payload
    };

    this.routeMessage(message);
  }

  // Route message to agent(s)
  routeMessage(message) {
    if (message.to === '*') {
      // Broadcast to all except sender
      for (const agent of this.agents.getAll()) {
        if (agent.id !== message.from) {
          this.deliverToAgent(agent, message);
        }
      }
    } else {
      // Unicast to specific agent
      const agent = this.agents.get(message.to);
      if (agent) {
        this.deliverToAgent(agent, message);
      }
    }

    // Emit for logging/UI
    this.emit('message', message);
  }

  // Deliver message to agent via PTY or API
  deliverToAgent(agent, message) {
    // Option 1: Agent has IPC support built-in
    // Send via special escape sequence or control message

    // Option 2: Agent wrapper intercepts messages
    // Store in agent's message queue, agent polls

    // For now: Store in agent's message queue
    if (!agent.messageQueue) {
      agent.messageQueue = [];
    }
    agent.messageQueue.push(message);

    // Notify agent via UI or bell
    agent.pty.write('\x07');  // Bell character
  }
}
```

### 2.3 Agent IPC Integration

**For agents that support IPC natively** (e.g., extended Claude CLI):

```javascript
// Agent sends messages via escape sequences
// OSC (Operating System Command): ESC ] <code> ; <data> ST

// Send request:
// ESC ] 1337 ; IPC = { "type": "request", ... } ST

// Agent listens for messages:
agent.pty.onData((data) => {
  const ipcMatch = data.match(/\x1b\]1337;IPC=({.*?})\x1b\\/);
  if (ipcMatch) {
    const message = JSON.parse(ipcMatch[1]);
    ipcHub.routeMessage(message);
  }
});
```

**For agents without IPC support**:

Create **agent wrapper/adapter** that provides IPC interface:

```javascript
class AgentAdapter {
  constructor(agent, ipcHub) {
    this.agent = agent;
    this.ipcHub = ipcHub;

    // Listen for IPC messages directed to this agent
    ipcHub.on('message', (msg) => {
      if (msg.to === agent.id) {
        this.handleMessage(msg);
      }
    });
  }

  handleMessage(message) {
    // Translate IPC message to agent input
    switch (message.method) {
      case 'execute_code':
        this.agent.pty.write(`${message.payload.code}\n`);
        break;

      case 'chat':
        this.agent.pty.write(`[IPC from ${message.from}]: ${message.payload.message}\n`);
        break;

      // ... more methods
    }
  }

  // Extract responses from agent output
  parseOutput(output) {
    // Look for special markers or patterns
    // Send response back through IPC hub
  }
}
```

### 2.4 IPC UI Components

**IPC Pane** (optional dedicated pane for inter-agent chat):

```
┌─────────────────────────────────┐
│ IPC Chat                         │
├─────────────────────────────────┤
│ [12:34] claude → codex          │
│   "Can you run this test?"      │
│                                  │
│ [12:35] codex → claude          │
│   "Sure, running now..."        │
│                                  │
│ [12:35] codex → *               │
│   "Test passed!"                │
└─────────────────────────────────┘
```

**IPC Command Mode** (`Ctrl+A`):

```
┌─────────────────────────────────┐
│ IPC Command Mode                 │
├─────────────────────────────────┤
│ s - Send to agent...            │
│ b - Broadcast to all            │
│ c - Start chat session          │
│ l - Show IPC log                │
│ ESC - Cancel                    │
└─────────────────────────────────┘
```

**IPC Status in Status Bar**:

```
[INSERT] [1:24/500 (5%)] | IPC: 3 pending | Agents: 3/3 active
```

---

## 3. Implementation Phases

### Phase 1: Agent Abstraction (Week 1-2)
**Goal**: Decouple agent implementation from UI.

- [ ] Create `Agent` class (wraps PTY + xterm Terminal)
- [ ] Create `AgentRegistry` (spawn, manage, discover agents)
- [ ] Create `agents.json` config system
- [ ] Refactor existing Claude spawning to use Agent class
- [ ] Test: Run single agent through new abstraction

### Phase 2: Layout System (Week 2-4)
**Goal**: Support multiple panes/tabs.

- [ ] Create `LayoutNode`, `Workspace`, `Container`, `Pane` classes
- [ ] Create `LayoutManager` (tree manipulation, focus, splits)
- [ ] Implement layout algorithm (bounds calculation)
- [ ] Implement Compositor (multi-viewport rendering)
- [ ] Draw borders and pane labels
- [ ] Test: Display 2+ agents side-by-side

### Phase 3: Input Routing (Week 4-5)
**Goal**: Route input to correct agent/layout command.

- [ ] Create `InputRouter` class
- [ ] Implement command mode (`Ctrl+Space`)
- [ ] Implement layout commands (`Ctrl+W` + hjkl/s/v/c)
- [ ] Implement tab switching (`Alt+1-9`)
- [ ] Implement focus highlight in compositor
- [ ] Test: Navigate between panes, split, close

### Phase 4: Multi-Agent Support (Week 5-6)
**Goal**: Spawn and manage multiple agent types.

- [ ] Add Codex agent adapter
- [ ] Add Gemini agent adapter
- [ ] Add generic custom agent adapter
- [ ] Create agent selection UI (command mode)
- [ ] Implement agent lifecycle (restart, kill)
- [ ] Test: Run Claude + Codex simultaneously

### Phase 5: IPC Foundation (Week 6-7)
**Goal**: Enable basic inter-agent communication.

- [ ] Design message protocol (JSON schema)
- [ ] Create `IPCHub` class (routing, queue)
- [ ] Implement request/response pattern
- [ ] Implement broadcast pattern
- [ ] Create IPC command mode (`Ctrl+A`)
- [ ] Test: Send message from Claude to Codex

### Phase 6: IPC UI (Week 7-8)
**Goal**: User-friendly IPC interfaces.

- [ ] Create IPC log pane (optional dedicated pane)
- [ ] Add IPC status to status bar
- [ ] Create IPC command menu
- [ ] Implement "send code to agent" workflow
- [ ] Implement "broadcast chat" workflow
- [ ] Test: Full sync/async IPC scenarios

### Phase 7: Advanced Features (Week 8+)
**Goal**: Polish and power-user features.

- [ ] Workspace persistence (save/restore layouts)
- [ ] Pane resize with mouse
- [ ] Pane zoom (temporary fullscreen)
- [ ] Agent templates (preconfigured setups)
- [ ] Shared clipboard between agents
- [ ] Agent output filtering/regex
- [ ] Performance optimization (throttle, lazy render)

---

## 4. File Structure

```
bukowski/
├── index.js                    # Main entry (refactored for multi-agent)
├── vim.js                      # VimHandler (unchanged)
├── search.js                   # SearchHandler (unchanged)
├── package.json
├── quotes.txt
├── LICENSE
├── README.md
├── MULTI_AGENT_DESIGN.md      # This document
│
├── src/
│   ├── core/
│   │   ├── Agent.js           # Agent class (PTY + Terminal wrapper)
│   │   ├── AgentRegistry.js   # Agent lifecycle management
│   │   ├── Viewport.js        # Moved from index.js, per-agent viewport
│   │   └── Compositor.js      # Multi-viewport rendering
│   │
│   ├── layout/
│   │   ├── LayoutNode.js      # Base class
│   │   ├── Workspace.js       # Tab/workspace
│   │   ├── Container.js       # Split container
│   │   ├── Pane.js            # Leaf pane with agent
│   │   └── LayoutManager.js   # Layout operations
│   │
│   ├── input/
│   │   ├── InputRouter.js     # Main input dispatcher
│   │   └── CommandMode.js     # Command menu UI
│   │
│   ├── ipc/
│   │   ├── IPCHub.js          # Message routing hub
│   │   ├── Message.js         # Message protocol types
│   │   └── AgentAdapter.js    # Adapter for non-IPC agents
│   │
│   ├── agents/
│   │   ├── ClaudeAgent.js     # Claude CLI adapter
│   │   ├── CodexAgent.js      # Codex adapter
│   │   ├── GeminiAgent.js     # Gemini adapter
│   │   └── CustomAgent.js     # Generic agent
│   │
│   └── ui/
│       ├── BorderRenderer.js  # Box-drawing characters
│       ├── StatusBar.js       # Status bar rendering
│       └── IPCPane.js         # IPC chat pane (optional)
│
└── config/
    ├── agents.json            # Agent definitions
    ├── keybindings.json       # Custom keybindings
    └── workspaces.json        # Saved workspace layouts
```

---

## 5. Technical Challenges & Solutions

### Challenge 1: Multiple xterm.js Terminals Performance

**Problem**: Each agent has its own Terminal instance. Memory/CPU?

**Solution**:
- Use headless mode (already doing this)
- Lazy instantiation (only create Terminal when pane is visible)
- Share SerializeAddon instances
- Throttle rendering per-pane (not just global)
- Consider terminal pooling for inactive agents

### Challenge 2: Synchronizing Viewport State Across Agents

**Problem**: Each agent can have different modes (insert/normal/visual).

**Solution**:
- Per-agent mode state (already in Agent class)
- Global mode displayed in status bar shows focused agent's mode
- Mode switches only affect focused agent
- Vim/search handlers operate on focused viewport

### Challenge 3: PTY Size Mismatches

**Problem**: Agents expect different terminal sizes, but panes are dynamic.

**Solution**:
- Resize PTY on layout changes: `agent.pty.resize(cols, rows)`
- Send `SIGWINCH` if agent doesn't respond to resize
- Buffer-based rendering (xterm buffer can be larger than pane)
- Scroll viewport within larger buffer

### Challenge 4: Agent Output Parsing for IPC

**Problem**: How do agents send IPC messages? Terminal output is unstructured.

**Solutions**:
1. **Escape Sequences** (Best): Agents use OSC sequences (like OSC 52 for clipboard)
   ```
   ESC ] 1337 ; IPC = <json> ST
   ```
   Parse in `agent.pty.onData()`, strip from visible output.

2. **Sideband Channel**: Agents write to separate file/socket
   ```javascript
   agent.ipcSocket = net.connect(`/tmp/bukowski-${agent.id}.sock`);
   ```

3. **Magic Comments**: Parse output for special markers
   ```
   # IPC: {"type": "response", ...}
   ```

4. **Agent Wrapper**: Proxy process that intercepts stdout/stdin
   ```
   bukowski → wrapper → actual-agent
   ```

### Challenge 5: Focus Management with Mouse

**Problem**: User clicks in a pane, should focus it.

**Solution**:
- Already have mouse support (SGR mode 1006)
- Calculate which pane contains click coordinates
- Update `layoutManager.focusedPane`
- Redraw with new focus highlight

### Challenge 6: Clipboard Sharing Between Agents

**Problem**: Copy in one agent, paste in another.

**Solution**:
- Already handle OSC 52 (clipboard operations)
- Intercept OSC 52 in agent PTY data handler
- Store in shared clipboard manager
- Allow paste in any agent

---

## 6. API Design Examples

### Example 1: Splitting a Pane

```javascript
// User presses Ctrl+W v (vertical split)
inputRouter.handleLayoutCommand('v');

// Internal flow:
layoutManager.splitVertical(focusedPane, promptForAgent());

// LayoutManager.splitVertical():
splitVertical(pane, newAgent) {
  const parent = pane.parent;  // Container or Workspace

  // Create new container to hold split
  const container = new Container({ orientation: 'vertical', ratio: [0.5, 0.5] });

  // Replace pane with container
  parent.replaceChild(pane, container);

  // Add original pane and new pane to container
  container.addChild(pane);
  const newPane = new Pane({ agent: newAgent });
  container.addChild(newPane);

  // Recalculate layout
  this.recalculate();

  // Focus new pane
  this.focusedPane = newPane;

  // Redraw
  compositor.render();
}
```

### Example 2: Sending Code to Another Agent

```javascript
// User in Claude pane, selects code in visual mode
// Presses Ctrl+A s (IPC send)

inputRouter.handleIPCCommand('s');

// Shows agent selection menu
commandMode.show('Select target agent:', agentRegistry.getAll());

// User selects "Codex"
const selectedCode = vim.getVisualSelection();

// Send IPC request
const response = await ipcHub.sendRequest(
  'claude-primary',
  'codex-1',
  'execute_code',
  {
    language: 'python',
    code: selectedCode,
    context: 'Claude asks: Can you run this?'
  }
);

// Show response in Claude's viewport
claude.viewport.push(`\n[IPC Response from Codex]:\n${response.stdout}\n`);
```

### Example 3: Broadcast Chat

```javascript
// User presses Ctrl+A b (broadcast)

inputRouter.handleIPCCommand('b');

// Enter chat mode
commandMode.show('Broadcast message:', '', { multiline: true });

// User types message
const message = commandMode.getValue();

// Broadcast to all agents
ipcHub.broadcast(
  layoutManager.focusedPane.agent.id,
  'chat',
  { message }
);

// All agents receive message in their viewports:
// [IPC Broadcast from Claude]: "Anyone know why this test is failing?"
```

---

## 7. Configuration Examples

### agents.json

```json
{
  "agents": [
    {
      "id": "claude-primary",
      "name": "Claude Sonnet",
      "type": "claude",
      "command": "node",
      "args": ["/usr/local/lib/claude/cli.js"],
      "env": {
        "FORCE_COLOR": "1",
        "CLAUDE_MODEL": "sonnet"
      },
      "autostart": true,
      "ipc": {
        "enabled": true,
        "methods": ["chat", "review_code", "execute_code"]
      }
    },
    {
      "id": "codex-1",
      "name": "OpenAI Codex",
      "type": "codex",
      "command": "python3",
      "args": ["-m", "openai_codex_cli"],
      "env": {
        "OPENAI_API_KEY": "${OPENAI_API_KEY}"
      },
      "autostart": false,
      "ipc": {
        "enabled": true,
        "adapter": "polling",
        "methods": ["execute_code"]
      }
    },
    {
      "id": "gemini-1",
      "name": "Google Gemini",
      "type": "gemini",
      "command": "gemini-cli",
      "args": ["--model", "gemini-pro"],
      "env": {},
      "autostart": false,
      "ipc": {
        "enabled": false
      }
    }
  ],
  "defaults": {
    "terminalSize": {
      "cols": 80,
      "rows": 500
    },
    "scrollback": 10000
  }
}
```

### keybindings.json

```json
{
  "global": {
    "Ctrl+Space": "command_mode",
    "Ctrl+C": "interrupt_agent"
  },
  "layout": {
    "prefix": "Ctrl+W",
    "bindings": {
      "h": "focus_left",
      "j": "focus_down",
      "k": "focus_up",
      "l": "focus_right",
      "s": "split_horizontal",
      "v": "split_vertical",
      "c": "close_pane",
      "o": "close_others",
      "=": "equalize_splits",
      "+": "resize_increase",
      "-": "resize_decrease",
      "H": "move_pane_left",
      "J": "move_pane_down",
      "K": "move_pane_up",
      "L": "move_pane_right"
    }
  },
  "tabs": {
    "Alt+1": "switch_tab_1",
    "Alt+2": "switch_tab_2",
    "Alt+3": "switch_tab_3",
    "Alt+4": "switch_tab_4",
    "Alt+5": "switch_tab_5",
    "Alt+6": "switch_tab_6",
    "Alt+7": "switch_tab_7",
    "Alt+8": "switch_tab_8",
    "Alt+9": "switch_tab_9",
    "Alt+t": "new_tab",
    "Alt+w": "close_tab"
  },
  "ipc": {
    "prefix": "Ctrl+A",
    "bindings": {
      "s": "send_to_agent",
      "b": "broadcast",
      "c": "start_chat",
      "l": "show_ipc_log"
    }
  }
}
```

### workspaces.json (Saved Layouts)

```json
{
  "workspaces": [
    {
      "id": "ws-1",
      "name": "Main",
      "layout": {
        "type": "container",
        "orientation": "horizontal",
        "ratio": [0.7, 0.3],
        "children": [
          {
            "type": "pane",
            "agent": "claude-primary"
          },
          {
            "type": "container",
            "orientation": "vertical",
            "ratio": [0.5, 0.5],
            "children": [
              {
                "type": "pane",
                "agent": "codex-1"
              },
              {
                "type": "pane",
                "agent": "gemini-1"
              }
            ]
          }
        ]
      }
    }
  ]
}
```

---

## 8. UI Mockups

### Single Workspace with 3 Panes

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━━┓
┃ Claude Sonnet                                  ┃ Codex                ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╋━━━━━━━━━━━━━━━━━━━━━━┫
┃                                                 ┃ >>> print("hello")   ┃
┃ I'll help you with that. Let me read the       ┃ hello                ┃
┃ file first.                                     ┃ >>>                  ┃
┃                                                 ┃                      ┃
┃ Reading: index.js                               ┃                      ┃
┃                                                 ┃                      ┃
┃ [File contents here...]                         ┃                      ┃
┃                                                 ┃                      ┃
┃                                                 ┣━━━━━━━━━━━━━━━━━━━━━━┫
┃                                                 ┃ Gemini Pro           ┃
┃                                                 ┣━━━━━━━━━━━━━━━━━━━━━━┫
┃                                                 ┃                      ┃
┃                                                 ┃ How can I help?      ┃
┃                                                 ┃                      ┃
┃                                                 ┃                      ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┻━━━━━━━━━━━━━━━━━━━━━━┛
[INSERT] Claude Sonnet [1:24/500 (5%)] | IPC: 0 | Agents: 3/3 | Ctrl+W:layout Ctrl+A:ipc
```

### Command Mode Menu

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                        Command Mode                                   ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃                                                                        ┃
┃  Layout:                                                               ┃
┃    Ctrl+W h/j/k/l  - Focus pane                                        ┃
┃    Ctrl+W s/v      - Split horizontal/vertical                         ┃
┃    Ctrl+W c        - Close pane                                        ┃
┃                                                                        ┃
┃  Tabs:                                                                 ┃
┃    Alt+1-9         - Switch workspace                                  ┃
┃    Alt+t           - New workspace                                     ┃
┃                                                                        ┃
┃  Agents:                                                               ┃
┃    a              - Spawn new agent                                    ┃
┃    r              - Restart focused agent                              ┃
┃    k              - Kill focused agent                                 ┃
┃                                                                        ┃
┃  IPC:                                                                  ┃
┃    Ctrl+A s        - Send to agent...                                  ┃
┃    Ctrl+A b        - Broadcast to all                                  ┃
┃                                                                        ┃
┃  Press any key or ESC to close                                         ┃
┃                                                                        ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

### IPC Chat Pane

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ IPC Chat Log                                                           ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃                                                                        ┃
┃ [12:34:56] claude → codex (request)                                   ┃
┃   Method: execute_code                                                 ┃
┃   Payload: {"language": "python", "code": "print('test')"}            ┃
┃                                                                        ┃
┃ [12:34:57] codex → claude (response)                                  ┃
┃   Payload: {"stdout": "test\n", "exitCode": 0}                        ┃
┃                                                                        ┃
┃ [12:35:10] claude → * (broadcast)                                     ┃
┃   Method: chat                                                         ┃
┃   Payload: {"message": "Anyone see the bug in index.js:123?"}         ┃
┃                                                                        ┃
┃ [12:35:15] gemini → * (broadcast)                                     ┃
┃   Method: chat                                                         ┃
┃   Payload: {"message": "Looking at it now..."}                         ┃
┃                                                                        ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
[LOG] IPC Chat [1:4/20 (20%)] | Press 'q' to close
```

---

## 9. Next Steps

1. **Review & Feedback**: Review this design doc, discuss trade-offs
2. **Prototype**: Build minimal Phase 1 (Agent abstraction) to validate approach
3. **Iterate**: Refine based on practical implementation challenges
4. **Document APIs**: Create API documentation for agent adapters
5. **Community**: Open-source friendly - document extension points

---

## 10. Open Questions

1. **Agent Discovery**: Should agents self-register, or only use config?
2. **Security**: Sandbox untrusted agents? Resource limits?
3. **Persistence**: Save agent state (history, context) between sessions?
4. **Performance**: Max number of concurrent agents?
5. **UI Complexity**: Too many keybindings? Need simpler interface?
6. **IPC Protocol**: JSON enough, or need binary protocol (protobuf)?
7. **Agent Death**: How to handle crashed agents? Auto-restart?
8. **Shared State**: Should agents share file system view, or isolated?

---

## Appendix A: Box-Drawing Characters

```
┌─┬─┐  ┏━┳━┓  ╔═╦═╗  Light / Heavy / Double
│ │ │  ┃ ┃ ┃  ║ ║ ║
├─┼─┤  ┣━╋━┫  ╠═╬═╣
│ │ │  ┃ ┃ ┃  ║ ║ ║
└─┴─┘  ┗━┻━┛  ╚═╩═╝
```

**Use heavy for focused pane**, light for inactive.

---

## Appendix B: Escape Sequences Reference

| Sequence | Description |
|----------|-------------|
| `\x1b[?1049h` | Enter alternate screen buffer |
| `\x1b[?1049l` | Exit alternate screen buffer |
| `\x1b[?25h` | Show cursor |
| `\x1b[?25l` | Hide cursor |
| `\x1b[?1000h` | Enable mouse tracking |
| `\x1b[?1006h` | Enable SGR mouse mode |
| `\x1b[?2026h` | Start synchronized update |
| `\x1b[?2026l` | End synchronized update |
| `\x1b]1337;...` | iTerm2 proprietary sequences (IPC) |
| `\x1b]52;c;...` | OSC 52 clipboard |

---

**End of Design Document**

*Last Updated: 2025-12-10*
*Author: Claude (with user guidance)*
*Version: 1.0 - Initial Design*
