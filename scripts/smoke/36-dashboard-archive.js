#!/usr/bin/env node
// Dashboard archive smoke (no PTY). Covers task-4: archive hides a settled
// entry from the default digest/query without deleting it, reversibly, audited.
//
// Invariants proven:
//   1. archived hides from digest AND query by default; includeArchived shows;
//      get-by-id (queryEntries{entryId}) ALWAYS returns it, with archived:true.
//   2. the `archived` flag round-trips through BOTH on-disk forms — JsonMarkdown
//      (reload from the same root) and the TatrStore TASK.md (serialize∘parse).
//   3. gating: curator OR owner-resident OR user may archive; a non-owner
//      non-curator is refused. unarchive is looser — any participant.
//   4. refuse-on-blocked-tail is CAPABLE, not decorative: the same archive is
//      refused while a live entry is blocked-on the target and SUCCEEDS once
//      that blocker is closed. The contrast is the test (tip-27).
//   5. reason is mandatory and lands in the audit log; bulk archives report
//      per-entry skips instead of failing the whole call.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DashboardStore } = require('../../src/dashboard/DashboardStore');
const { _internals } = require('../../src/dashboard/TatrStore');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bukowski-arch-'));
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

function expectErr(code, fn) {
  try { fn(); } catch (e) {
    const m = /^DASHBOARD_ERROR (.*)$/.exec(e.message);
    assert(m, `expected tagged DASHBOARD_ERROR, got: ${e.message}`);
    const { code: got } = JSON.parse(m[1]);
    assert.strictEqual(got, code, `expected ${code}, got ${got}`);
    return;
  }
  throw new Error(`expected ${code} to be thrown`);
}

const CURATOR = 'claude-bukowski-1';
const MED = 'claude-meddaemon-1';
const AZRA = 'claude-azra-1';

const store = new DashboardStore({ root: ROOT });
const repos = [
  { repo: 'meddaemon', root: '/home/sheemeh/projects/meddaemon' },
  { repo: 'azra', root: '/home/sheemeh/projects/azra' },
];
const PID = store.createProject(CURATOR, { name: 'Archive Smoke', goal: 'g', repos }, { ts: 1000 }).projectId;
let ts = 2000;
const mk = (caller, repo, oneliner) => store.setEntry(caller,
  { projectId: PID, repo, category: 'bugs', oneliner, refs: [`${repo}://sha/1`] }, { ts: ts++ }).entryId;

const b1 = mk(MED, 'meddaemon', 'stale bug one');
const b2 = mk(MED, 'meddaemon', 'stale bug two');
const bOwn = mk(AZRA, 'azra', 'azra own bug');

// ── reason is mandatory ──────────────────────────────────────────────────────
expectErr('BAD_KEY', () => store.archiveEntry(CURATOR, { projectId: PID, entryId: b1 }));
console.log('OK: archive without a reason is refused (reason kept in audit)');

// ── 1. archive hides from digest + query; get-by-id still returns it ─────────
const beforeQ = store.queryEntries(CURATOR, { projectId: PID }).entries.map((e) => e.id);
assert(beforeQ.includes(b1), 'b1 visible before archive');

store.archiveEntry(CURATOR, { projectId: PID, entryId: b1, reason: 'settled months ago' });

const afterQ = store.queryEntries(CURATOR, { projectId: PID }).entries.map((e) => e.id);
assert(!afterQ.includes(b1), 'archived b1 hidden from default query');
assert(afterQ.includes(b2), 'non-archived b2 still visible');

const withArch = store.queryEntries(CURATOR, { projectId: PID, includeArchived: true }).entries.map((e) => e.id);
assert(withArch.includes(b1), 'includeArchived surfaces b1');

const digest = store.digest(CURATOR, { projectId: PID }).digest;
assert(!digest.includes(b1), 'archived b1 absent from default digest');
assert(store.digest(CURATOR, { projectId: PID, includeArchived: true }).digest.includes(b1),
  'includeArchived surfaces b1 in digest');

const byId = store.queryEntries(CURATOR, { projectId: PID, entryId: b1 }).entries[0];
assert.strictEqual(byId.archived, true, 'get-by-id always returns the archived entry, with the flag');
console.log('OK: archived hidden from default digest+query; includeArchived + get-by-id surface it');

// ── 2. the flag round-trips on disk (JsonMarkdown reload) ────────────────────
const reloaded = new DashboardStore({ root: ROOT });
const rById = reloaded.queryEntries(CURATOR, { projectId: PID, entryId: b1 }).entries[0];
assert.strictEqual(rById.archived, true, 'archived survives serialize→disk→reload (JsonMarkdown)');
assert(!reloaded.queryEntries(CURATOR, { projectId: PID }).entries.map((e) => e.id).includes(b1),
  'reloaded store still hides b1 by default');
console.log('OK: archived round-trips through the JsonMarkdown <category>.md file');

// ── 2b. and through the TatrStore TASK.md frontmatter ────────────────────────
{
  const { serializeTask, parseTask } = _internals;
  const e = { id: 'bug-9', status: 'closed', oneliner: 'x', owner: MED, repo: 'meddaemon', refs: [], links: [], tags: [], ts: 5, archived: true };
  const round = parseTask(serializeTask(e, 'bugs')).entry;
  assert.strictEqual(round.archived, true, 'archived round-trips through TASK.md frontmatter');
  const active = parseTask(serializeTask({ ...e, archived: false }, 'bugs')).entry;
  assert.strictEqual(active.archived, false, 'absent archived frontmatter parses as not-archived (back-compat)');
  console.log('OK: archived round-trips through the TatrStore TASK.md form');
}

// ── 3. gating ────────────────────────────────────────────────────────────────
// a participant who is neither the owner's host-resident nor the curator: refused
expectErr('NOT_RESPONSIBLE', () => store.archiveEntry(AZRA, { projectId: PID, entryId: b2, reason: 'not mine' }));
// but AZRA can archive its OWN entry (capable: the gate isn't refusing everything)
store.archiveEntry(AZRA, { projectId: PID, entryId: bOwn, reason: 'azra retires its own' });
assert.strictEqual(store.queryEntries(CURATOR, { projectId: PID, entryId: bOwn }).entries[0].archived, true,
  'owner-resident archives its own entry');
// owner-resident of meddaemon archives b2
store.archiveEntry(MED, { projectId: PID, entryId: b2, reason: 'med retires b2' });
console.log('OK: curator + owner-resident may archive; a non-owner non-curator is refused');

// ── 3b. unarchive: any participant, incl. one who could not archive ──────────
store.unarchiveEntry(AZRA, { projectId: PID, entryId: b2 }); // AZRA could NOT archive b2, but may unarchive it
assert(store.queryEntries(CURATOR, { projectId: PID }).entries.map((e) => e.id).includes(b2),
  'any participant can unarchive — the deadlock escape');
expectErr('NOT_RESPONSIBLE', () => store.unarchiveEntry('claude-stranger-1', { projectId: PID, entryId: b1 }));
console.log('OK: any participant unarchives; a non-participant is refused');

// ── 4. refuse-on-blocked-tail, proven capable by contrast ────────────────────
const target = mk(MED, 'meddaemon', 'depended-on bug');          // meddaemon-owned
const blocker = mk(AZRA, 'azra', 'needs the depended-on bug');    // azra-owned, LIVE
store.linkBlockedOn(AZRA, { projectId: PID, entryId: blocker, rel: 'blocked-on', targets: [target] });

// while the blocker is live, archiving the target is refused
expectErr('BLOCKED_TAIL', () => store.archiveEntry(CURATOR, { projectId: PID, entryId: target, reason: 'tidy' }));
// close the blocker → the same archive now succeeds (the guard discriminates)
store.closeEntry(AZRA, { projectId: PID, entryId: blocker });
store.archiveEntry(CURATOR, { projectId: PID, entryId: target, reason: 'tidy, now unblocked' });
assert.strictEqual(store.queryEntries(CURATOR, { projectId: PID, entryId: target }).entries[0].archived, true,
  'archive succeeds once the blocked-on tail is closed');
console.log('OK: archive refused while a live entry is blocked-on it; allowed once that blocker closes');

// ── 5. bulk archive reports per-entry skips ──────────────────────────────────
const c1 = mk(MED, 'meddaemon', 'bulk one');
const c2 = mk(MED, 'meddaemon', 'bulk two');
const res = store.archiveEntry(CURATOR, { projectId: PID, entryIds: [c1, c2, 'bug-999'], reason: 'bulk tidy' });
assert.deepStrictEqual(res.archived.sort(), [c1, c2].sort(), 'bulk archives the real ids');
assert.strictEqual(res.skipped.length, 1, 'the missing id is skipped, not fatal');
assert.strictEqual(res.skipped[0].id, 'bug-999', 'skip names the missing id');
console.log('OK: bulk archive succeeds on valid ids and reports the skips');

// ── dashboard_unlink clears a stale blocked-on tail so archive can proceed ───
// A blocked-on edge left behind after its dependency resolved reads to the
// archive guard as a real block. removeLink is the escape: drop the stale tail
// and the target archives even though the (now mis-linked) holder is still open.
const t2 = mk(MED, 'meddaemon', 'depended-on, tail went stale');
const holder = mk(AZRA, 'azra', 'holder with a stale blocked-on edge');
store.linkBlockedOn(AZRA, { projectId: PID, entryId: holder, rel: 'blocked-on', targets: [t2] });
expectErr('BLOCKED_TAIL', () => store.archiveEntry(CURATOR, { projectId: PID, entryId: t2, reason: 'x' }));
// gate: a non-resident of the holder's host cannot unlink it
expectErr('NOT_RESPONSIBLE', () => store.removeLink(MED, { projectId: PID, entryId: holder, targets: [t2] }));
// owner drops the stale tail; archive now proceeds though `holder` is still open
const ur = store.removeLink(AZRA, { projectId: PID, entryId: holder, rel: 'blocked-on', targets: [t2] });
assert.strictEqual(ur.removed, 1, 'unlink removes the one stale blocked-on edge');
store.archiveEntry(CURATOR, { projectId: PID, entryId: t2, reason: 'tail was stale, unlinked' });
assert.strictEqual(store.queryEntries(CURATOR, { projectId: PID, entryId: t2 }).entries[0].archived, true,
  'archive proceeds after the stale blocked-on tail is unlinked');
// a no-op unlink (missing target) changes nothing and bumps no rev
const revBefore = store.projects.get(PID).rev;
const noop = store.removeLink(AZRA, { projectId: PID, entryId: holder, targets: ['nope'] });
assert.strictEqual(noop.unchanged, true, 'unlink of a missing target is a no-op');
assert.strictEqual(store.projects.get(PID).rev, revBefore, 'no-op unlink does not bump rev');
console.log('OK: dashboard_unlink clears a stale blocked-on tail; no-op unlink bumps nothing');

// ── audit: the archive op + reason is in the append-only log ─────────────────
const auditDir = path.join(ROOT, PID, '_audit');
const auditTxt = fs.readdirSync(auditDir).map((f) => fs.readFileSync(path.join(auditDir, f), 'utf-8')).join('');
assert(/"op":"archive"/.test(auditTxt) && /settled months ago/.test(auditTxt),
  'archive op and its reason are recorded in the audit log');
console.log('OK: archive is audited (op + reason kept)');

console.log('OK: dashboard archive smoke passed');
process.exit(0);
