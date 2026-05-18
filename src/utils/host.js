// src/utils/host.js - Shared helpers for deriving a bukowski "host" name
// from a working directory. The host segment is the middle piece of an
// agent's federated ID (claude-<host>-<n>).

const path = require('path');
const crypto = require('crypto');

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

module.exports = { hostFromCwd, shortHash };
