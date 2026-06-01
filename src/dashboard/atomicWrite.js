// src/dashboard/atomicWrite.js - torn-write-safe file write.
//
// Lifts the tmp-then-rename idiom proven in PeerRegistry._writeOwnFile: a plain
// writeFileSync truncates first and then writes, so a co-located reader that
// catches the file mid-flight sees an empty / partial blob. Writing to a
// sibling temp file and renaming in place means readers always see either the
// previous state or the new state, never a torn one. (rename is atomic within a
// filesystem.)

const fs = require('fs');

/**
 * Atomically write `data` to `file`. The temp name is keyed by pid so two
 * processes never collide on the same temp path.
 * @param {string} file - destination path
 * @param {string|Buffer} data
 * @param {object} [opts] - { mode } (default 0o600)
 */
function atomicWrite(file, data, opts = {}) {
  const mode = opts.mode ?? 0o600;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

module.exports = { atomicWrite };
