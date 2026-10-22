#!/usr/bin/env node
/**
 * Session-id ownership (bug-20).
 *
 * Two claude panes share one cwd, so discovering "which transcript belongs to
 * which agent" by newest-mtime is reliably wrong: the earliest-spawned agent
 * takes whichever .jsonl was written last — normally its SIBLING's, since that
 * is the pane that just spoke — and the exclusion set hands the leftover back.
 * Both agents resume each other's history on the next restore.
 *
 * The fix is to stop discovering: bukowski mints the id, passes it as
 * --session-id, and marks it authoritative so capture never re-derives it.
 */

const { getFreshSessionArgs, createAgentTypes } = require('../../src/bootstrap');

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}`); }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Minimal stand-ins: the helper only reads `ownsSessionId`.
const TYPES = {
  claude: { ownsSessionId: true },
  codex: {},
  gemini: {},
};

console.log('1. claude owns its session id');
const a = getFreshSessionArgs(TYPES, 'claude', []);
ok(a.args[0] === '--session-id', 'emits --session-id');
ok(UUID_RE.test(a.args[1]), 'with a real uuid');
ok(a.sessionId === a.args[1], 'and returns that id for the caller to record');

console.log('2. ids are unique per agent');
const ids = new Set();
for (let i = 0; i < 50; i++) ids.add(getFreshSessionArgs(TYPES, 'claude', []).sessionId);
ok(ids.size === 50, '50 spawns produce 50 distinct ids (no sibling can collide)');

console.log('3. types that do not support the flag are untouched');
for (const t of ['codex', 'gemini']) {
  const r = getFreshSessionArgs(TYPES, t, []);
  ok(r.args.length === 0 && r.sessionId === null, `${t} gets no --session-id`);
}
ok(getFreshSessionArgs(TYPES, 'nonesuch', []).sessionId === null, 'unknown type is a no-op');
ok(getFreshSessionArgs(null, 'claude', []).sessionId === null, 'missing type table is a no-op');

console.log('4. never combined with a caller-supplied resume/continue');
for (const flag of ['--resume', '-r', '--continue', '-c', '--from-pr', '--session-id']) {
  const r = getFreshSessionArgs(TYPES, 'claude', ['--settings', '{}', flag]);
  ok(r.args.length === 0 && r.sessionId === null,
    `${flag} present → we do not add our own (claude rejects the combination)`);
}
ok(getFreshSessionArgs(TYPES, 'claude', ['--settings', '{}']).sessionId !== null,
  'unrelated args still get an id');
ok(getFreshSessionArgs(TYPES, 'claude', null).sessionId !== null,
  'null arg list is tolerated');

console.log('5. the swap scenario cannot recur');
// Two panes, same cwd, spawned back to back. Under the old code both ids came
// from one mtime-ordered scan of a shared directory; now neither agent's id
// depends on the other's existence or on any filesystem state.
const pane1 = getFreshSessionArgs(TYPES, 'claude', []);
const pane2 = getFreshSessionArgs(TYPES, 'claude', []);
ok(pane1.sessionId !== pane2.sessionId, 'two same-cwd panes get different ids');
ok(UUID_RE.test(pane1.sessionId) && UUID_RE.test(pane2.sessionId), 'both are valid uuids');
ok(pane1.args[1] === pane1.sessionId && pane2.args[1] === pane2.sessionId,
  'each agent is launched with the exact id recorded for it');

console.log('6. the real claude config declares ownership');
const real = createAgentTypes('claude', null);
ok(real.claude.ownsSessionId === true, 'AGENT_TYPES.claude.ownsSessionId is set');
ok(!real.codex.ownsSessionId, 'codex does not claim it (resolved from /proc instead)');
ok(!real.gemini.ownsSessionId, 'gemini does not claim it');
const realFresh = getFreshSessionArgs(real, 'claude', real.claude.args);
ok(realFresh.sessionId !== null, 'the real claude config yields an id for a fresh spawn');
ok(real.claude.getResumeArgs('x').length === 2, 'resume path is unchanged');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('OK: session-id ownership smoke passed');
