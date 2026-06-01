#!/usr/bin/env node
// Dashboard store unit smoke (no PTY). Proves the DashboardStore invariants:
//   1. Markdown round-trips byte-stably (serialize ∘ parse ∘ serialize == serialize).
//   2. Governance: curator-only create, owner-scoped writes, <=80 one-liner,
//      actionable-category ref requirement.
//   3. The pointers-not-content rule holds on disk (no body strings; lines short).
//   4. walkChain reconstructs the 5-hop, 3-repo causal chain from refs alone.
//
// Pass: all assertions hold. Fail: throws / exits 1.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DashboardStore } = require('../../src/dashboard/DashboardStore');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bukowski-dash-'));
function cleanup() { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} }
process.on('exit', cleanup);

function expectErr(code, fn) {
  try { fn(); } catch (e) {
    const m = /^DASHBOARD_ERROR (.*)$/.exec(e.message);
    assert(m, `expected tagged DASHBOARD_ERROR, got: ${e.message}`);
    const { code: got } = JSON.parse(m[1]);
    assert.strictEqual(got, code, `expected error code ${code}, got ${got}`);
    return;
  }
  throw new Error(`expected ${code} to be thrown`);
}

const CURATOR = 'claude-bukowski-1';
const MED = 'claude-meddaemon-1';
const AZRA = 'claude-azra-1';
const SDK = 'claude-azra-sdk-kotlin-1';

const store = new DashboardStore({ root: ROOT });

// ── 1. project creation: the CREATOR becomes the curator by default ──────────
const solo = store.createProject('claude-azra-1', { name: 'Azra Solo', goal: 'g', repos: [{ repo: 'azra', root: '/home/sheemeh/projects/azra/azra' }] }, { ts: 1 });
assert.strictEqual(store.projects.get(solo.projectId).curator, 'claude-azra-1', 'creator becomes curator by default');

const repos = [
  { repo: 'meddaemon', root: '/home/sheemeh/projects/meddaemon' },
  { repo: 'azra', root: '/home/sheemeh/projects/azra' },
  { repo: 'azra-sdk-kotlin', root: '/home/sheemeh/projects/azra-sdk-kotlin' },
];
const cp = store.createProject(CURATOR, { name: 'OpenAI as a Judge', goal: 'drive android app live on device', repos }, { ts: 1000 });
assert.strictEqual(cp.projectId, 'openai-as-a-judge');
const PID = cp.projectId;

// participants derived from repo owners, curator/projects excluded
const proj = store.projects.get(PID);
assert.deepStrictEqual(proj.participants.sort(), [AZRA, SDK, MED].sort());

// ── 2. governance on setEntry ────────────────────────────────────────────────
// non-owner can't write another repo's entry
expectErr('NOT_RESPONSIBLE', () => store.setEntry(AZRA, { projectId: PID, repo: 'meddaemon', category: 'bugs', oneliner: 'x', refs: ['meddaemon://sha/1'] }));
// actionable category needs a ref
expectErr('MISSING_REFS', () => store.setEntry(MED, { projectId: PID, repo: 'meddaemon', category: 'bugs', oneliner: 'no refs here' }));
// one-liner length cap
expectErr('ONELINER_TOO_LONG', () => store.setEntry(MED, { projectId: PID, repo: 'meddaemon', category: 'bugs', oneliner: 'x'.repeat(81), refs: ['meddaemon://sha/1'] }));
// bad project
expectErr('BAD_PROJECT', () => store.queryEntries(MED, { projectId: 'nope' }));

// ── 3. the 5-hop causal chain fixture (3 repos) ──────────────────────────────
let ts = 2000;
store.setEntry(MED, { projectId: PID, repo: 'meddaemon', category: 'bugs', oneliner: 'broker CHANNEL_SUBSCRIBE_ACK lands', refs: ['meddaemon://sha/112abcb'], causal_parent: 'conv:687b00cb' }, { ts: ts++, conv: '687b00cb', msgId: 'm1' });
store.setEntry(MED, { projectId: PID, repo: 'meddaemon', category: 'bugs', oneliner: 'correlation rides message_uuid', refs: ['meddaemon://sha/f8d17ee'], causal_parent: 'meddaemon://sha/112abcb' }, { ts: ts++, conv: '687b00cb', msgId: 'm2' });
store.setEntry(SDK, { projectId: PID, repo: 'azra-sdk-kotlin', category: 'tasks', oneliner: 'kotlin SDK subscribeAwaitAck shim', refs: ['azra-sdk-kotlin://sha/b57d25f'], causal_parent: 'meddaemon://sha/f8d17ee' }, { ts: ts++, conv: '687b00cb', msgId: 'm3' });
store.setEntry(AZRA, { projectId: PID, repo: 'azra', category: 'tasks', oneliner: 'consumer drops 300ms drain hack', refs: ['azra://sha/108fa48'], causal_parent: 'azra-sdk-kotlin://sha/b57d25f' }, { ts: ts++, conv: '687b00cb', msgId: 'm4' });

const chain = store.walkChain('azra://sha/108fa48').chain;
assert.deepStrictEqual(chain.map((n) => n.ref), [
  'conv:687b00cb',
  'meddaemon://sha/112abcb',
  'meddaemon://sha/f8d17ee',
  'azra-sdk-kotlin://sha/b57d25f',
  'azra://sha/108fa48',
], 'causal chain should reconstruct root-first from refs alone');
assert.deepStrictEqual(chain.map((n) => n.repo), ['conv', 'meddaemon', 'meddaemon', 'azra-sdk-kotlin', 'azra']);
console.log('OK: walkChain reconstructed 5 hops across 3 repos from refs alone');

// ── 4. promote / close / comment / link ──────────────────────────────────────
const setRes = store.setEntry(AZRA, { projectId: PID, repo: 'azra', category: 'nicetohaves', oneliner: 'maybe add retry backoff', refs: ['azra://sha/aaa'] }, { ts: ts++ });
const promoted = store.promoteEntry(AZRA, { projectId: PID, entryId: setRes.entryId, toCategory: 'tasks' }, { ts: ts++ });
assert(promoted.entryId.startsWith('task-'), 'promote re-files into tasks with a new id prefix');
assert.strictEqual(store.queryEntries(AZRA, { projectId: PID, category: 'nicetohaves' }).entries.length, 0, 'promoted entry left nicetohaves');
store.linkBlockedOn(AZRA, { projectId: PID, entryId: promoted.entryId, blockedOn: ['meddaemon://entry/bug-1'] }, { ts: ts++ });
store.commentEntry(MED, { projectId: PID, entryId: promoted.entryId, text: 'meddaemon side ready' }, { ts: ts++ });
store.closeEntry(AZRA, { projectId: PID, entryId: promoted.entryId }, { ts: ts++ });
// a non-owner cannot close someone else's entry (bug-1 is meddaemon's)
expectErr('NOT_RESPONSIBLE', () => store.closeEntry(AZRA, { projectId: PID, entryId: 'bug-1' }));
// the owner can
store.closeEntry(MED, { projectId: PID, entryId: 'bug-1' }, { ts: ts++ });
console.log('OK: promote/link/comment/close governance holds');

// ── 4b. claim / in-progress collision visibility (the duplicate-PR incident) ──
store.setEntry(AZRA, { projectId: PID, repo: 'azra', category: 'tasks', oneliner: 'upstream subscribeAwaitAck', refs: ['azra://pr/329'], state: 'claimed' }, { ts: ts++ });
const collide = store.setEntry(SDK, { projectId: PID, repo: 'azra-sdk-kotlin', category: 'tasks', oneliner: 'also upstream subscribeAwaitAck', refs: ['azra-sdk-kotlin://pr/330'], state: 'in_progress' }, { ts: ts++ });
assert(collide.inProgressElsewhere && collide.inProgressElsewhere.some((e) => e.owner === AZRA),
  'claiming in_progress must surface another agent already mid-flight in the same category');
console.log('OK: claim surfaces in-progress collision (would have caught the dup PR)');

// ── 4c. typed links: supersedes extends the causal chain ─────────────────────
const dup = store.setEntry(SDK, { projectId: PID, repo: 'azra-sdk-kotlin', category: 'bugs', oneliner: 'redundant dup PR, closed', refs: ['azra-sdk-kotlin://pr/330'] }, { ts: ts++ });
const fix = store.setEntry(SDK, { projectId: PID, repo: 'azra-sdk-kotlin', category: 'bugs', oneliner: 'fix that supersedes the dup', refs: ['azra-sdk-kotlin://pr/331'] }, { ts: ts++ });
store.linkBlockedOn(SDK, { projectId: PID, entryId: fix.entryId, rel: 'supersedes', targets: ['azra-sdk-kotlin://pr/330'] }, { ts: ts++ });
const supChain = store.walkChain('azra-sdk-kotlin://pr/331').chain.map((n) => n.ref);
assert.deepStrictEqual(supChain, ['azra-sdk-kotlin://pr/330', 'azra-sdk-kotlin://pr/331'],
  'supersedes link should extend dashboard_chain (#331 supersedes #330)');
console.log('OK: supersedes link renders as a causal chain');

// ── 4d. DAG: an entry with BOTH caused-by and supersedes surfaces both ────────
const dual = store.setEntry(SDK, { projectId: PID, repo: 'azra-sdk-kotlin', category: 'bugs', oneliner: 'fix with two lineages', refs: ['azra-sdk-kotlin://pr/441'] }, { ts: ts++ });
store.linkBlockedOn(SDK, { projectId: PID, entryId: dual.entryId, rel: 'caused-by', targets: ['azra-sdk-kotlin://pr/439'] }, { ts: ts++ });
store.linkBlockedOn(SDK, { projectId: PID, entryId: dual.entryId, rel: 'supersedes', targets: ['azra-sdk-kotlin://pr/440'] }, { ts: ts++ });
const dag = store.walkChain('azra-sdk-kotlin://pr/441');
const dualRels = dag.edges.filter((e) => e.from === 'azra-sdk-kotlin://pr/441').map((e) => e.rel).sort();
assert.deepStrictEqual(dualRels, ['caused-by', 'supersedes'], 'both parent lineages must appear in edges (DAG, no silent drop)');
assert.deepStrictEqual(dag.chain.map((n) => n.ref), ['azra-sdk-kotlin://pr/439', 'azra-sdk-kotlin://pr/441'], 'chain spine follows caused-by by precedence');
console.log('OK: walkChain surfaces full DAG — caused-by + supersedes both visible (new anomaly fix)');

// ── 4e. curator transfer + framework-curator offline-recovery ─────────────────
assert.strictEqual(store.transferCurator('claude-bukowski-1', { projectId: PID, to: 'claude-meddaemon-1' }, { ts: ts++ }).curator, 'claude-meddaemon-1', 'curator transfers to new lead');
// framework curator can reassign even when it is NOT the current project lead (offline recovery)
assert.strictEqual(store.transferCurator('claude-bukowski-1', { projectId: PID, to: 'claude-azra-1' }, { ts: ts++ }).curator, 'claude-azra-1', 'framework curator recovers an offline lead');
expectErr('NOT_CURATOR', () => store.transferCurator('claude-azra-agent-1', { projectId: PID, to: 'claude-azra-agent-1' }, { ts: ts++ }));
console.log('OK: curator transfer + framework-curator offline-recovery');

// ── 4f. roadmap array arriving JSON-stringified renders clean (Anomaly 4) ─────
store.setRoadmap('user', { projectId: PID, roadmap: JSON.stringify([{ text: 'Phase A', children: [{ text: 'step one', refs: ['x://sha/1'] }] }]) }, { ts: ts++ });
const rmDigest = store.digest('user', { projectId: PID }).digest;
assert(!rmDigest.includes('"children"'), 'JSON-stringified roadmap array must NOT leak raw JSON into the digest');
assert(rmDigest.includes('A. Phase A') && rmDigest.includes('1. step one'), 'roadmap renders as a clean A./1. outline');
console.log('OK: JSON-stringified roadmap array renders as clean outline (Anomaly 4 fix)');

// ── 4g. curator election: vote + auto-tally + curator-online guard ────────────
// curator = bukowski-1 (excluded from participants), so both repo owners are candidates.
const ep = store.createProject('claude-bukowski-1', { name: 'Elect Test', goal: 'g', curator: 'claude-bukowski-1', repos: [
  { repo: 'meddaemon', root: '/home/sheemeh/projects/meddaemon' },
  { repo: 'azra', root: '/home/sheemeh/projects/azra/azra' },
] }, { ts: ts++ });
const EPID = ep.projectId;
const online = ['claude-meddaemon-1', 'claude-azra-1'];
// can't elect while the curator is reachable
expectErr('CURATOR_ONLINE', () => store.openElection('claude-meddaemon-1', { projectId: EPID }, { ts: ts++ }, { curatorOnline: true, onlineParticipants: online }));
store.openElection('claude-meddaemon-1', { projectId: EPID }, { ts: ts++ }, { curatorOnline: false, onlineParticipants: online });
store.vote('claude-meddaemon-1', { projectId: EPID, candidate: 'claude-azra-1' }, { ts: ts++ });
const v2 = store.vote('claude-azra-1', { projectId: EPID, candidate: 'claude-azra-1' }, { ts: ts++ });
assert.strictEqual(v2.tallied, true, 'election auto-tallies once all candidates voted');
assert.strictEqual(store.projects.get(EPID).curator, 'claude-azra-1', 'election winner (2 votes) becomes curator');
console.log('OK: curator election — vote, auto-tally, curator-online guard');

// ── 4h. tie resolves deterministically (convergent across reload) ─────────────
const tp = store.createProject('claude-bukowski-1', { name: 'Tie Test', goal: 'g', curator: 'claude-bukowski-1', repos: [
  { repo: 'meddaemon', root: '/home/sheemeh/projects/meddaemon' },
  { repo: 'azra', root: '/home/sheemeh/projects/azra/azra' },
] }, { ts: ts++ });
const TPID = tp.projectId;
store.openElection('claude-azra-1', { projectId: TPID }, { ts: ts++ }, { curatorOnline: false, onlineParticipants: online });
store.vote('claude-meddaemon-1', { projectId: TPID, candidate: 'claude-meddaemon-1' }, { ts: ts++ });
store.vote('claude-azra-1', { projectId: TPID, candidate: 'claude-azra-1' }, { ts: ts++ }); // 1-1 tie → deterministic tiebreak
const tieWinner = store.projects.get(TPID).curator;
assert(online.includes(tieWinner), 'tie resolves to one of the tied candidates');
assert.strictEqual(new DashboardStore({ root: ROOT }).projects.get(TPID).curator, tieWinner, 'tiebreak is deterministic across a fresh reload');
console.log('OK: election tie resolves deterministically (convergent)');

// ── 5. round-trip: reload from disk, deep-equal ──────────────────────────────
const store2 = new DashboardStore({ root: ROOT });
const p1 = store.projects.get(PID);
const p2 = store2.projects.get(PID);
assert.strictEqual(p2.goal, p1.goal);
for (const cat of ['bugs', 'tasks']) {
  // deepStrictEqual is key-order-insensitive; byte-stability is checked in §6.
  assert.deepStrictEqual(p2.categories[cat], p1.categories[cat], `category ${cat} did not round-trip through disk`);
}
console.log('OK: store round-trips through disk');

// ── 6. byte-stable re-serialize + pointers-not-content on disk ───────────────
const { _internals } = require('../../src/dashboard/DashboardStore');
const bugsMd = fs.readFileSync(path.join(ROOT, PID, 'bugs.md'), 'utf-8');
const reser = _internals.serializeCategory('bugs', p1.name, _internals.parseCategory(bugsMd));
assert.strictEqual(reser, bugsMd, 'bugs.md must re-serialize byte-identically');

// no entry line may exceed the structural cap (id+status+oneliner portion <= ~120)
for (const line of bugsMd.split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue;
  const m = line.match(/^(\S+)\s+\[[^\]]+\]\s+(.*?)(\s+::.*)?$/);
  const oneliner = m ? m[2] : '';
  assert(oneliner.length <= 80, `on-disk one-liner exceeds 80 chars: ${oneliner}`);
}

// audit log exists and carries causal_parent, not bodies
const auditDir = path.join(ROOT, PID, '_audit');
const auditFiles = fs.readdirSync(auditDir);
assert(auditFiles.length >= 1, 'audit log should exist');
const auditLines = fs.readFileSync(path.join(auditDir, auditFiles[0]), 'utf-8').trim().split('\n');
const hasCause = auditLines.map((l) => JSON.parse(l)).some((r) => r.causal_parent === 'conv:687b00cb');
assert(hasCause, 'audit must carry causal_parent refs');
console.log('OK: bytes stable, one-liners capped, audit carries causal refs');

// ── 7. identity: a local session caller (claude-1) is federated to ───────────
//      claude-<host>-1 so it can write its OWN repo (Anomaly 1 fix).
const ID_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-id-'));
process.on('exit', () => { try { fs.rmSync(ID_ROOT, { recursive: true, force: true }); } catch {} });
process.env.BUKOWSKI_HOST = 'meddaemon';
const store3 = new DashboardStore({ root: ID_ROOT });
store3.createProject('claude-bukowski-1', { name: 'Id Test', goal: 'g', repos: [{ repo: 'meddaemon', root: '/home/sheemeh/projects/meddaemon' }] }, { ts: 1 });
const idRes = store3.setEntry('claude-1', { projectId: 'id-test', repo: 'meddaemon', category: 'bugs', oneliner: 'local caller writes own repo', refs: ['meddaemon://sha/x'] }, { ts: 2 });
assert(idRes.ok && idRes.entryId, 'local session caller (claude-1) must map to claude-meddaemon-1 and write meddaemon');
const idEntry = store3.queryEntries('claude-1', { projectId: 'id-test' }).entries[0];
assert.strictEqual(idEntry.owner, 'claude-meddaemon-1', 'entry owner should be the federated id');
delete process.env.BUKOWSKI_HOST;
console.log('OK: local caller federated to claude-<host>-1 for ownership (Anomaly 1 fix)');

// ── 8. chain found-flag: unknown ref vs grounded root (Anomaly 2 fix) ─────────
assert.strictEqual(store.walkChain('conv:does-not-exist').found, false, 'unknown ref → found:false');
assert.strictEqual(store.walkChain('meddaemon://sha/112abcb').found, true, 'grounded ref → found:true');
console.log('OK: chain found-flag distinguishes unknown vs grounded (Anomaly 2 fix)');

console.log('OK: dashboard-store smoke passed');
process.exit(0);
