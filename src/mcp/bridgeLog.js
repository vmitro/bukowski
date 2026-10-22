/**
 * One append-only line per bridge lifecycle event.
 *
 * The MCP bridge had no voice. When codex sat in a pane reporting "bukowski:
 * connected (38 tools)" while every call fell through to a diagnostics blob,
 * answering "did it ever ask for the tools, and what did it get" took an
 * afternoon of /proc archaeology — the bridge itself had recorded nothing. Its
 * stderr is no help either: a bridge spawned by codex's machine-global
 * app-server-daemon writes stderr into that daemon's log, four processes away
 * from the pane the human is looking at.
 *
 * So events go to stderr AND to one file per box. Volume is deliberately low —
 * lifecycle only, never per-call, and a down instance logs its first failed
 * attempt rather than one every five seconds — so the file stays greppable for
 * weeks instead of being rotated out within the hour.
 *
 * stdout is NEVER touched: it carries the MCP JSON-RPC stream and a stray byte
 * there desynchronises the client.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_LOG = path.join(os.homedir(), '.bukowski', 'bridge.log');
const MAX_BYTES = 8 * 1024 * 1024;
const OFF = new Set(['off', '0', 'none', 'false']);

/**
 * Where lines are appended, or null when file logging is disabled.
 * BUKOWSKI_BRIDGE_LOG names a path, or switches it off entirely.
 */
function logFilePath(env = process.env) {
  const v = env.BUKOWSKI_BRIDGE_LOG;
  if (v === undefined || v === '') return DEFAULT_LOG;
  if (OFF.has(String(v).toLowerCase())) return null;
  return v;
}

/**
 * Render one field value. Unset fields are dropped by the caller; everything
 * else is kept on a single line so each event is one grep hit, with spaces
 * quoted rather than mangled.
 */
function formatValue(value) {
  if (value === null) return 'null';
  const s = String(value);
  return /[\s"=]/.test(s) ? JSON.stringify(s) : s;
}

/**
 * `<iso> [bridge] pid=N event=connect socket=/tmp/x.sock via=cwd`
 *
 * Field order is insertion order, with pid first, because these lines are read
 * by eye as often as by grep.
 */
function formatEvent(event, fields = {}, opts = {}) {
  const now = opts.now || new Date();
  const pid = opts.pid === undefined ? process.pid : opts.pid;
  const parts = [`${now.toISOString()} [bridge] pid=${pid} event=${event}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${formatValue(v)}`);
  }
  return parts.join(' ');
}

/**
 * Keep the file bounded without a cron job: one generation of history, checked
 * before each append. Cheap enough at this event rate, and a failed rotation is
 * never allowed to cost us the line.
 */
function rotateIfLarge(file, fsImpl = fs) {
  try {
    if (fsImpl.statSync(file).size < MAX_BYTES) return;
    fsImpl.renameSync(file, `${file}.1`);
  } catch { /* missing file, or a racing bridge already rotated it */ }
}

/**
 * Create the log's directory, at most once per process and never recursively.
 *
 * `mkdirSync(dir, {recursive: true})` HANGS — not fails, spins forever — when
 * the path cannot exist under procfs: node retries the walk indefinitely.
 * Called from a bridge's boot path that is a hair's breadth from stdin setup,
 * that freezes the whole bridge before it ever answers a request, and a
 * mistyped BUKOWSKI_BRIDGE_LOG would be enough to do it. A single
 * non-recursive mkdir fails instantly instead, and the only case it gives up
 * on — a log two or more levels below anything that exists — costs us the file,
 * not the bridge.
 */
let dirAttempted = null;
function ensureLogDir(file, fsImpl = fs) {
  const dir = path.dirname(file);
  if (dirAttempted === dir) return;
  dirAttempted = dir;
  try { fsImpl.mkdirSync(dir); } catch { /* already there, or out of reach */ }
}

/**
 * Record one event. Best-effort by contract: a bridge that cannot write its
 * log must still carry traffic, so every failure here is swallowed.
 */
function bridgeLog(event, fields = {}, opts = {}) {
  const line = formatEvent(event, fields, opts);
  const err = opts.stderr || process.stderr;
  try { err.write(`${line}\n`); } catch { /* closed pipe */ }

  const file = opts.file !== undefined ? opts.file : logFilePath(opts.env);
  if (!file) return line;
  const fsImpl = opts.fs || fs;
  try {
    ensureLogDir(file, fsImpl);
    rotateIfLarge(file, fsImpl);
    fsImpl.appendFileSync(file, `${line}\n`);
  } catch { /* unwritable home, read-only fs, full disk */ }
  return line;
}

/** Test seam: the once-per-process dir attempt is cached. */
function resetDirCache() { dirAttempted = null; }

module.exports = {
  bridgeLog, formatEvent, formatValue, logFilePath, resetDirCache, DEFAULT_LOG, MAX_BYTES,
};
