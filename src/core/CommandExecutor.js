// src/core/CommandExecutor.js - Vim-style command execution (:w, :q, :sp, etc.)

const { Session } = require('./Session');

/**
 * CommandExecutor - Handles vim-style colon commands
 *
 * Commands: :q, :w, :wq, :sp, :vs, :e, :set, :sessions, :restore, :name
 */
class CommandExecutor {
  constructor(options) {
    this.layoutManager = options.layoutManager;
    this.terminal = options.terminal;
    this.session = options.session;
    this.ipcHub = options.ipcHub;
    this.fipaHub = options.fipaHub;
    this.dispatcher = options.dispatcher;
    this.AGENT_TYPES = options.AGENT_TYPES;
    this.resolveAgentType = options.resolveAgentType;

    // Callbacks for operations that need access to multi.js scope
    this.onCaptureAgentSessions = options.onCaptureAgentSessions || (() => Promise.resolve());
    this.onSetOutputSilence = options.onSetOutputSilence || (() => {});
    this.onShowStatusMessage = options.onShowStatusMessage || (() => {});
  }

  /**
   * Execute a colon command
   * @param {string} cmd - Command string (without leading colon)
   */
  execute(cmd) {
    const parts = cmd.trim().split(/\s+/);
    const command = parts[0];
    const args = parts.slice(1);

    switch (command) {
      case 'q':
      case 'quit':
        this._quit(false);
        break;

      case 'q!':
      case 'quit!':
      case 'qa':
      case 'qa!':
      case 'qall':
      case 'qall!':
        this._quit(true);
        break;

      case 'e':
      case 'edit':
        this._edit(args);
        break;

      case 'sp':
      case 'split':
        this._split('horizontal', args);
        break;

      case 'vs':
      case 'vsp':
      case 'vsplit':
        this._split('vertical', args);
        break;

      case 'set':
        this._set(args);
        break;

      case 'only':
      case 'on':
        this.dispatcher.dispatch({ action: 'close_others' });
        break;

      case 'close':
      case 'clo':
        this.dispatcher.dispatch({ action: 'close_pane' });
        break;

      case 'w':
      case 'write':
      case 'save':
        this._save(args, false);
        break;

      case 'wq':
      case 'x':
        this._save(args, true);
        break;

      case 'sessions':
      case 'ls':
        this._listSessions();
        break;

      case 'restore':
      case 'load':
        this._showRestoreHint(args);
        break;

      case 'name':
      case 'rename':
        if (args[0]) {
          this.session.name = args[0];
        }
        break;

      default:
        // Unknown command - silently ignore
        break;
    }
  }

  _quit(force) {
    const panes = this.layoutManager.getAllPanes();
    if (!force && panes.length > 1) {
      // Close focused pane only
      this.dispatcher.dispatch({ action: 'close_pane' });
    } else {
      // Quit application
      this.terminal.cleanup();
      if (this.ipcHub) this.ipcHub.stop();
      this.session.destroy();
      process.exit(0);
    }
  }

  _edit(args) {
    const agentType = this.resolveAgentType(this.AGENT_TYPES, args[0]);
    if (agentType) {
      const extraArgs = args.slice(1);
      this.dispatcher.dispatch({ action: 'new_tab', agentType, extraArgs });
    }
  }

  _split(direction, args) {
    const agentType = this.resolveAgentType(this.AGENT_TYPES, args[0]);
    if (agentType) {
      const extraArgs = args.slice(1);
      const action = direction === 'horizontal' ? 'split_horizontal' : 'split_vertical';
      this.dispatcher.dispatch({ action, agentType, extraArgs });
    }
  }

  _set(args) {
    if (!args.length) return;

    const assignment = args.join(' ');
    let key, value;

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
    if (!key || !value) return;

    if (['output_silence', 'output_silence_ms', 'output-silence', 'output_silence_duration'].includes(key)) {
      const ms = Math.max(0, parseInt(value, 10));
      if (!Number.isNaN(ms)) {
        this.onSetOutputSilence(ms);
        process.env.BUKOWSKI_OUTPUT_SILENCE_DURATION = String(ms);
      }
    } else if (key === 'scrollback') {
      const sb = Math.max(0, parseInt(value, 10));
      if (!Number.isNaN(sb)) {
        process.env.BUKOWSKI_SCROLLBACK = String(sb);
      }
    }
  }

  _save(args, andQuit) {
    // Set name if provided
    if (args[0]) {
      this.session.name = args[0];
    }

    // Error if session has no name (like vim's "No file name")
    if (!this.session.name) {
      this.onShowStatusMessage('E32: No session name (use :w <name>)');
      return;
    }

    // Sync focused pane ID to session before saving
    this.session.focusedPaneId = this.layoutManager.focusedPaneId;

    // If zoomed, save the unzoomed layout (so restore gets full layout)
    const wasZoomed = this.layoutManager.isZoomed();
    const zoomedLayout = wasZoomed ? this.session.layout : null;
    if (wasZoomed) {
      this.session.layout = this.layoutManager.savedLayout;
    }

    // Capture agent session IDs before saving
    this.onCaptureAgentSessions()
      .then(() => {
        return this.session.save(undefined, this.fipaHub.conversations);
      })
      .then(() => {
        // Restore zoomed state after save
        if (wasZoomed) {
          this.session.layout = zoomedLayout;
        }

        if (andQuit) {
          this.terminal.cleanup();
          if (this.ipcHub) this.ipcHub.stop();
          this.session.destroy();
          process.exit(0);
        }
      })
      .catch(() => {
        // Restore zoomed state on error too
        if (wasZoomed) {
          this.session.layout = zoomedLayout;
        }

        if (andQuit) {
          this.terminal.cleanup();
          if (this.ipcHub) this.ipcHub.stop();
          this.session.destroy();
          process.exit(1);
        }
      });
  }

  _listSessions() {
    Session.listSessions().then(sessions => {
      if (sessions.length === 0) return;

      let output = '\r\n--- Saved Sessions ---\r\n';
      for (const s of sessions.slice(0, 10)) {
        const date = new Date(s.updatedAt).toLocaleString();
        output += `  ${s.name} (${s.id.slice(0, 8)}) - ${s.agentCount} agents - ${date}\r\n`;
      }
      output += '----------------------\r\n';

      const focusedPane = this.layoutManager.getFocusedPane();
      const focusedAgent = focusedPane ? this.session.getAgent(focusedPane.agentId) : null;
      if (focusedAgent?.terminal) {
        focusedAgent.terminal.write(output);
      }
    });
  }

  _showRestoreHint(args) {
    const target = args[0] || 'latest';
    const focusedPane = this.layoutManager.getFocusedPane();
    const focusedAgent = focusedPane ? this.session.getAgent(focusedPane.agentId) : null;
    if (focusedAgent?.terminal) {
      focusedAgent.terminal.write(`\r\nTo restore session "${target}", restart with: bukowski --restore ${target}\r\n`);
    }
  }
}

module.exports = { CommandExecutor };
