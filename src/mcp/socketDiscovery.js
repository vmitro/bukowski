/**
 * Helpers for binding an MCP bridge to the right bukowski instance.
 *
 * The bridge used to pick an instance by process ancestry, which looks
 * authoritative and is not. codex runs a machine-global `app-server-daemon`:
 * the first codex session on the box starts it, and every later codex session
 * — in any pane, any repo — attaches to that same daemon, which spawns the
 * MCP bridge as its own child. The bridge therefore inherits the ancestry of
 * whichever bukowski happened to start the daemon. On this box that bound the
 * projects pane's codex to the azra-agent instance: it answered as
 * codex-azra-agent-1, its roster showed azra-agent's agents, and messages
 * addressed to it piled up unread in the projects instance's queue.
 *
 * The working directory survives that indirection — the daemon spawns the
 * bridge in the session's own directory — so cwd is the signal to bind on.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SOCKETS_DIR = path.join(os.homedir(), '.bukowski', 'sockets');

/**
 * Check if a PID is still running.
 */
function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-pid discovery files are named by pid and nothing else. parseInt would
 * happily read "3525338.meta" as pid 3525338 and then treat its JSON as a
 * socket path, so match strictly.
 */
function pidFromFileName(name) {
  return /^\d+$/.test(String(name)) ? parseInt(name, 10) : NaN;
}

/**
 * Read an instance's sidecar metadata ({socket, pid, cwd}). Returns null for
 * instances older than the cwd-binding change; callers treat that as "makes
 * no cwd claim" and fall back to the previous behaviour rather than ignoring
 * the instance.
 * @param {number} pid
 * @param {string} [dir] - override for tests
 */
function readInstanceMeta(pid, dir = SOCKETS_DIR) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${pid}.meta`), 'utf-8'));
    return meta && typeof meta.cwd === 'string' ? meta : null;
  } catch {
    return null;
  }
}

/**
 * Is `dir` the same directory as `base`, or inside it? Decides whether an
 * instance could plausibly own a bridge running in `dir`. Path-segment aware:
 * "/a/projects-old" is NOT inside "/a/projects".
 */
function isWithin(base, dir) {
  if (!base || !dir) return false;
  const b = path.resolve(base);
  const d = path.resolve(dir);
  return d === b || d.startsWith(b + path.sep);
}

/**
 * Running instances that could own a bridge in `cwd`, best match first.
 * "Best" = deepest cwd: with instances in ~/projects and
 * ~/projects/azra-agent, a bridge in the latter belongs to the latter.
 * @param {string} cwd
 * @param {object} [opts] - { dir, isRunning } overrides for tests
 */
function instancesOwningCwd(cwd, opts = {}) {
  const dir = opts.dir || SOCKETS_DIR;
  const isRunning = opts.isRunning || isPidRunning;
  const exists = opts.exists || fs.existsSync;
  const out = [];
  try {
    for (const file of fs.readdirSync(dir)) {
      const pid = pidFromFileName(file);
      if (isNaN(pid) || !isRunning(pid)) continue;
      const meta = readInstanceMeta(pid, dir);
      if (!meta || !isWithin(meta.cwd, cwd)) continue;
      if (!exists(meta.socket)) continue;
      out.push({ pid, socket: meta.socket, cwd: path.resolve(meta.cwd) });
    }
  } catch { /* directory may not exist yet */ }
  // Deepest cwd wins; stable by pid so a tie is not arbitrary run to run.
  return out.sort((a, b) => (b.cwd.length - a.cwd.length) || (a.pid - b.pid));
}

module.exports = {
  SOCKETS_DIR,
  isPidRunning,
  pidFromFileName,
  readInstanceMeta,
  isWithin,
  instancesOwningCwd,
};
