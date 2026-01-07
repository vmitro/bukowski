/**
 * TerminalManager - Terminal setup/cleanup and signal handlers
 */

const fs = require('fs');

class TerminalManager {
  constructor(socketDiscoveryFile) {
    this.socketDiscoveryFile = socketDiscoveryFile;
    this.activeSession = null;
    this.activeCompositor = null;
    this.shutdownCallbacks = [];
  }

  /**
   * Setup terminal for TUI mode
   */
  setup() {
    process.stdout.write('\x1b[?1049h');            // Enter alt screen
    process.stdout.write('\x1b[?1000h\x1b[?1006h'); // Enable mouse (SGR mode)
    process.stdout.write('\x1b[?25l');              // Hide cursor (compositor manages it)
  }

  /**
   * Cleanup terminal state
   */
  cleanup() {
    process.stdout.write('\x1b[?1000l\x1b[?1006l'); // Disable mouse
    process.stdout.write('\x1b[?25h');              // Show cursor
    process.stdout.write('\x1b[?1049l');            // Exit alt screen

    // Remove socket discovery file
    if (this.socketDiscoveryFile) {
      try {
        fs.unlinkSync(this.socketDiscoveryFile);
      } catch {
        // Ignore - file may not exist
      }
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
