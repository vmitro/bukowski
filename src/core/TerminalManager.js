/**
 * TerminalManager - Terminal setup/cleanup and signal handlers
 */

const fs = require('fs');

class TerminalManager {
  constructor(socketDiscoveryFile, legacySocketFile) {
    this.socketDiscoveryFile = socketDiscoveryFile;
    this.legacySocketFile = legacySocketFile;
    this.socketPath = null; // Track our socket path for cleanup
    this.activeSession = null;
    this.activeCompositor = null;
    this.shutdownCallbacks = [];
  }

  /**
   * Set socket path (for cleanup to know which socket belongs to us)
   */
  setSocketPath(socketPath) {
    this.socketPath = socketPath;
  }

  /**
   * Setup terminal for TUI mode
   */
  setup() {
    process.stdout.write('\x1b[?1049h');            // Enter alt screen
    // Mouse (SGR) reporting. Some constrained SSH clients — notably ConnectBot
    // on Android — mishandle mouse-mode escapes badly enough to garble or drop
    // the whole session. BUKOWSKI_NO_MOUSE=1 skips enabling it so those clients
    // stay usable (you lose click/scroll, keyboard nav is unaffected).
    if (process.env.BUKOWSKI_NO_MOUSE !== '1') {
      process.stdout.write('\x1b[?1000h\x1b[?1006h'); // Enable mouse (SGR mode)
    }
    process.stdout.write('\x1b[?25l');              // Hide cursor (compositor manages it)
  }

  /**
   * Cleanup terminal state
   */
  cleanup() {
    // Restore stdin to cooked mode FIRST. multi.js puts stdin in raw mode for
    // the TUI; without undoing it a crash/exit leaves the terminal with no echo
    // and no line editing — which over SSH looks exactly like a dropped session
    // ("kicked out"), when the connection is actually still up. This is the
    // tty-wedge fix.
    try {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
        process.stdin.setRawMode(false);
      }
    } catch { /* ignore */ }

    process.stdout.write('\x1b[?1000l\x1b[?1006l'); // Disable mouse
    process.stdout.write('\x1b[?25h');              // Show cursor
    process.stdout.write('\x1b[?1049l');            // Exit alt screen

    // Remove per-PID socket discovery file (always ours)
    if (this.socketDiscoveryFile) {
      try {
        fs.unlinkSync(this.socketDiscoveryFile);
      } catch { /* ignore */ }
    }

    // Only remove legacy file if it still points to our socket
    // (avoids clobbering newer session's legacy file)
    if (this.legacySocketFile && this.socketPath) {
      try {
        const current = fs.readFileSync(this.legacySocketFile, 'utf-8').trim();
        if (current === this.socketPath) {
          fs.unlinkSync(this.legacySocketFile);
        }
      } catch { /* ignore */ }
    }
  }

  /**
   * Set references needed for signal handlers
   */
  setSession(session) {
    this.activeSession = session;
  }

  setCompositor(compositor) {
    this.activeCompositor = compositor;
  }

  /**
   * Register callback for shutdown (SIGINT/SIGTERM)
   * @param {Function} callback - Called before exit
   */
  onShutdown(callback) {
    this.shutdownCallbacks.push(callback);
  }

  /**
   * Register all signal handlers
   */
  registerSignalHandlers() {
    const self = this;

    // Exit cleanup
    process.on('exit', () => self.cleanup());

    // A crash must never leave the terminal wedged (raw mode + alt screen). On
    // an uncaught error, restore the terminal, print the error to the RESTORED
    // screen so it's readable (an alt-screen crash is otherwise invisible), then
    // exit. Without this, a startup throw (e.g. a failed agent spawn) would drop
    // the user into a dead-looking shell.
    const onFatal = (label) => (err) => {
      try { self.cleanup(); } catch { /* ignore */ }
      try {
        process.stderr.write(`\n[bukowski] fatal ${label}: ${(err && err.stack) || err}\n`);
      } catch { /* ignore */ }
      process.exit(1);
    };
    process.on('uncaughtException', onFatal('uncaughtException'));
    process.on('unhandledRejection', onFatal('unhandledRejection'));

    // SIGTSTP handler (CTRL+Z) - suspend gracefully
    process.on('SIGTSTP', () => {
      // 1. Clean up terminal state
      self.cleanup();

      // 2. Stop all child PTYs
      if (self.activeSession) {
        for (const agent of self.activeSession.getAllAgents()) {
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
      process.kill(process.pid, 'SIGSTOP');
    });

    // SIGCONT handler - resume after suspend
    process.on('SIGCONT', () => {
      // 1. Resume all child PTYs
      if (self.activeSession) {
        for (const agent of self.activeSession.getAllAgents()) {
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
      self.setup();

      // 3. Force full redraw (immediate)
      if (self.activeCompositor) {
        self.activeCompositor.draw();
      }
    });

    // SIGINT handler (CTRL+C)
    process.on('SIGINT', () => {
      self.cleanup();
      for (const callback of self.shutdownCallbacks) {
        try { callback(); } catch { /* ignore */ }
      }
      process.exit(0);
    });

    // SIGTERM handler
    process.on('SIGTERM', () => {
      self.cleanup();
      for (const callback of self.shutdownCallbacks) {
        try { callback(); } catch { /* ignore */ }
      }
      process.exit(0);
    });
  }
}

module.exports = { TerminalManager };
