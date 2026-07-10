// src/utils/host.js - Shared helpers for deriving a bukowski "host" name
// from a working directory. The host segment is the middle piece of an
// agent's federated ID (claude-<host>-<n>).

const path = require('path');
const crypto = require('crypto');
const os = require('os');

// Sanitize a directory basename for use as an agent ID segment.
// Replaces anything outside [A-Za-z0-9_-] with '_', strips leading/trailing
// dashes/underscores, and falls back to 'ext' for empty/root paths.
function hostFromCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd) return 'ext';
  const base = path.basename(cwd);
  if (!base || base === '/' || base === '.') return 'ext';
  const sanitized = base.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[-_]+|[-_]+$/g, '');
  return sanitized || 'ext';
}

// Short, stable disambiguator. Used when two bukowskis in directories with
// the same basename are both live — the second one to start appends this.
function shortHash(input) {
  return crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, 4);
}

// The TRUE machine identity, distinct from the cwd-derived routing host
// (claude-<host>-N). Two boxes that both clone into a dir named "bukowski"
// share a routing host but never a machineHost — so this is what lets an agent
// tell one "bukowski" from another in list_agents. BUKOWSKI_MACHINE overrides
// (a friendly label like "1blu" beats the raw "v3629.1blu.de"); otherwise the
// first label of os.hostname(). Sanitized like a host segment; 'unknown' if
// nothing resolves.
function machineHost() {
  const raw = String(process.env.BUKOWSKI_MACHINE || os.hostname() || '').split('.')[0];
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[-_]+|[-_]+$/g, '');
  return sanitized || 'unknown';
}

module.exports = { hostFromCwd, shortHash, machineHost };
