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
 * An instance's working directory. Prefers its sidecar, falls back to the
 * kernel.
 *
 * The fallback is what makes this durable: instances written before the
 * sidecar existed make no cwd claim, and if cwd binding only worked for
 * upgraded instances then a SHALLOWER upgraded instance could capture a
 * bridge belonging to a DEEPER un-upgraded one (projects at ~/projects
 * swallowing azra-agent at ~/projects/azra-agent). /proc knows the cwd of
 * every running instance regardless of version, so the fleet does not have
 * to restart in lockstep for the binding to be correct.
 *
 * Linux-only; elsewhere the readlink fails and we fall back to the sidecar,
 * which is the pre-existing behaviour.
 */
function instanceCwd(pid, dir = SOCKETS_DIR, cwdOf = null) {
  const meta = readInstanceMeta(pid, dir);
  if (meta && meta.cwd) return meta.cwd;
  try {
    return (cwdOf || ((q) => fs.readlinkSync(`/proc/${q}/cwd`)))(pid);
  } catch {
    return null;
  }
}

/**
 * An instance's socket path: sidecar first, then the bare pid file that every
 * version has always written.
 */
function instanceSocket(pid, dir = SOCKETS_DIR) {
  const meta = readInstanceMeta(pid, dir);
  if (meta && meta.socket) return meta.socket;
  try {
    return fs.readFileSync(path.join(dir, String(pid)), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Running instances that could own a bridge in `cwd`, best match first.
 * "Best" = deepest cwd: with instances in ~/projects and
 * ~/projects/azra-agent, a bridge in the latter belongs to the latter.
 * @param {string} cwd
 * @param {object} [opts] - { dir, isRunning } overrides for tests
 */
function liveInstances(opts = {}) {
  const dir = opts.dir || SOCKETS_DIR;
  const isRunning = opts.isRunning || isPidRunning;
  const exists = opts.exists || fs.existsSync;
  const out = [];
  try {
    for (const file of fs.readdirSync(dir)) {
      const pid = pidFromFileName(file);
      if (isNaN(pid) || !isRunning(pid)) continue;
      const theirCwd = instanceCwd(pid, dir, opts.cwdOf);
      if (!theirCwd) continue;
      const socket = instanceSocket(pid, dir);
      if (!socket || !exists(socket)) continue;
      out.push({ pid, socket, cwd: path.resolve(theirCwd) });
    }
  } catch { /* directory may not exist yet */ }
  return out;
}

function instancesOwningCwd(cwd, opts = {}) {
  return liveInstances(opts)
    .filter((i) => isWithin(i.cwd, cwd))
    // Deepest cwd wins; stable by pid so a tie is not arbitrary run to run.
    .sort((a, b) => (b.cwd.length - a.cwd.length) || (a.pid - b.pid));
}

/**
 * Live instances sitting in EXACTLY this directory.
 *
 * This is how a bridge finds its way home after the instance it was bound to
 * is replaced. A restart changes the pid and the socket path but not the
 * directory the instance runs in, so the old instance's cwd is the one durable
 * handle on "the same seat as before" — and following it beats the alternative,
 * which was to take whichever instance on the box had been touched most
 * recently (see chooseSocket's caller).
 */
function instancesWithCwd(cwd, opts = {}) {
  if (!cwd) return [];
  const want = path.resolve(cwd);
  return liveInstances(opts)
    .filter((i) => i.cwd === want)
    .sort((a, b) => a.pid - b.pid);
}

/**
 * The instance pid encoded in a socket path (bukowski-mcp-<pid>.sock).
 */
function pidFromSocketPath(socketPath) {
  const m = /bukowski-mcp-(\d+)\.sock$/.exec(String(socketPath || ''));
  return m ? parseInt(m[1], 10) : NaN;
}

/**
 * Is this socket backed by a LIVE instance?
 *
 * Existence is not enough. `tmux respawn-pane -k` SIGKILLs, so cleanup never
 * runs and /tmp keeps the dead instance's socket file. A bridge that trusted
 * mere existence would keep dialling a socket nobody listens on — which is
 * what left azra-agent's codex with "bukowski: connected (38 tools)" and no
 * working call after its instance was respawned.
 *
 * A path we cannot attribute to a pid is taken at face value rather than
 * rejected, so custom socket paths keep working.
 */
function socketIsLive(socketPath, opts = {}) {
  const exists = opts.exists || fs.existsSync;
  const isRunning = opts.isRunning || isPidRunning;
  if (!socketPath || !exists(socketPath)) return false;
  const pid = pidFromSocketPath(socketPath);
  if (isNaN(pid)) return true;
  return isRunning(pid);
}

/**
 * Decide which socket to use given an explicit env override and the instances
 * that own our cwd.
 *
 * BUKOWSKI_MCP_SOCKET used to win on existence alone, which is wrong when the
 * env is inherited rather than earned. Claude Code pre-warms a `bg-spare`
 * process pool: a spare created by one pane carries that pane's
 * BUKOWSKI_MCP_SOCKET/BUKOWSKI_AGENT_ID and is then handed to a session in a
 * DIFFERENT workspace, so the agent doing projects work bound to the
 * azra-agent instance and drained azra's claude-2 queue (bug-22).
 *
 * Conservative on purpose: env is overridden only when it names an instance
 * that does NOT own our cwd AND some other running instance does. With no
 * better candidate the env is kept, so a pane that merely cd'd outside its
 * instance's tree is unaffected.
 */
function chooseSocket({ envPath, envExists, owners }) {
  if (envPath && envExists) {
    if (!owners || owners.length === 0) return { socket: envPath, via: 'env' };
    if (owners.some((o) => o.socket === envPath)) return { socket: envPath, via: 'env' };
    return { socket: owners[0].socket, via: 'cwd-override', overridden: envPath };
  }
  if (owners && owners.length) return { socket: owners[0].socket, via: 'cwd' };
  return null;
}

/**
 * Should a bridge already bound to `currentSocket` move to a different
 * instance? Returns the better owner, or null to stay put.
 *
 * Binding was a one-shot decision, and that is wrong while instances churn.
 * If the instance that owns our cwd exactly is momentarily down, the only live
 * instance CONTAINING our cwd is an ancestor — ~/projects legitimately claims
 * a bridge whose cwd is ~/projects/azra-agent. The pick is right at that
 * instant and wrong a second later, and nothing re-evaluated it: azra's codex
 * sat registered on the projects instance as codex-azra-agent-2 for twenty
 * minutes, with its own instance running beside it, because the link was
 * healthy — just to the wrong box.
 *
 * Only a STRICTLY deeper owner justifies moving; equal depth is not a reason
 * to churn.
 */
function betterOwnerThan(currentSocket, owners) {
  if (!owners || owners.length === 0) return null;
  const best = owners[0];
  if (!currentSocket) return best;
  if (best.socket === currentSocket) return null;
  const current = owners.find((o) => o.socket === currentSocket);
  // Bound to something that does not own our cwd at all: anything is better.
  if (!current) return best;
  return best.cwd.length > current.cwd.length ? best : null;
}

module.exports = {
  SOCKETS_DIR,
  liveInstances,
  instancesWithCwd,
  isPidRunning,
  pidFromFileName,
  readInstanceMeta,
  isWithin,
  instanceCwd,
  instanceSocket,
  instancesOwningCwd,
  pidFromSocketPath,
  socketIsLive,
  chooseSocket,
  betterOwnerThan,
};
