// src/utils/procTree.js - /proc process-tree facts, read SERVER-SIDE.
//
// Identity for a bridge connection used to rest on an ancestor-pid list the
// CLIENT computed and sent. That had three failure modes, and all three ended
// the same way: the match missed, the connection fell through to cwd-based
// naming, and one process ended up with two unrelated agent ids (bug-16).
//
//   1. The client's walk started at process.ppid, so a bridge that had exec'd
//      into the pane process itself — its own pid being the pty's pid — could
//      never match.
//   2. The walk stopped at the first /proc entry it could not read. A single
//      exited intermediate truncated the chain and threw away every ancestor
//      ABOVE it, including the pty.
//   3. A depth cap of 10 was not enough for a real pane: tmux → shell → node
//      wrapper → REPL → bridge nests deeper than it looks.
//
// Deriving it here fixes all three in one place and stops a client from simply
// asserting its lineage: it can still lie about WHICH pid it is, but not about
// that pid's parents. Linux-only by construction; every reader treats absent
// /proc as "no evidence" and never as a match.
//
// Containment is the ONLY evidence used. Sharing a process session or a
// controlling terminal is not evidence of anything here: every process started
// from one shell shares both, so a REPL sitting beside a pane in the same
// terminal would be absorbed INTO that pane — two processes answering as one
// agent, which is worse than the two-ids-for-one-process bug this fixes.

const fs = require('fs');

// `/proc/<pid>/stat` is positional, and field 2 (comm) may contain spaces and
// parentheses — so split AFTER the last ')' rather than on whitespace.
// Post-comm fields, 1-based from state: 1 state, 2 ppid, 4 sid, 5 tty_nr.
function parseStat(pid) {
  let raw;
  try { raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8'); } catch { return null; }
  const close = raw.lastIndexOf(')');
  if (close === -1) return null;
  const rest = raw.slice(close + 1).trim().split(/\s+/);
  if (rest.length < 5) return null;
  const ppid = Number(rest[1]);
  const sid = Number(rest[3]);
  const tty = Number(rest[4]);
  if (!Number.isFinite(ppid) || !Number.isFinite(sid) || !Number.isFinite(tty)) return null;
  return { pid: Number(pid), ppid, sid, tty };
}

/**
 * The pid itself plus every ancestor up to (but excluding) init. Includes the
 * starting pid deliberately: a bridge that exec'd into the pane IS the pane.
 * A pid whose stat cannot be read ends the walk — there is no ppid to follow —
 * but everything collected so far is kept rather than discarded.
 */
function ancestorsOf(pid, maxDepth = 64) {
  const out = [];
  const seen = new Set();
  let cur = Number(pid);
  for (let i = 0; i < maxDepth && Number.isFinite(cur) && cur > 1; i++) {
    if (seen.has(cur)) break; // defensive: /proc should never cycle
    seen.add(cur);
    out.push(cur);
    const st = parseStat(cur);
    if (!st) break;
    cur = st.ppid;
  }
  return out;
}

/**
 * Pick the session agent a bridge connection runs inside: the agent whose pty
 * pid is the client's own pid or one of its ancestors. Returns null when that
 * cannot be established — callers must then mint a separate identity rather
 * than guess, because a wrong match merges two distinct agents.
 *
 * `claimedPids` are the client's self-reported ancestors, honoured only as a
 * fallback for bridges too old to send a pid.
 */
function resolvePaneAgent(agents, { pid, claimedPids } = {}) {
  const withPty = (agents || []).filter((a) => a && a.pty && Number.isFinite(Number(a.pty.pid)));
  if (!withPty.length) return null;

  const lineage = pid ? ancestorsOf(pid) : [];
  const claimed = Array.isArray(claimedPids) ? claimedPids.map(Number).filter(Number.isFinite) : [];
  const candidates = new Set([...lineage, ...claimed]);
  if (!candidates.size) return null;

  const hit = withPty.find((a) => candidates.has(Number(a.pty.pid)));
  if (!hit) return null;
  return { agent: hit, via: lineage.includes(Number(hit.pty.pid)) ? 'lineage' : 'claimed' };
}

module.exports = { parseStat, ancestorsOf, resolvePaneAgent };
