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

// ── 4i. double-open guard + delete-project governance ─────────────────────────
const gp = store.createProject('claude-bukowski-1', { name: 'Guard Test', goal: 'g', curator: 'claude-ghost-1', repos: [
  { repo: 'meddaemon', root: '/home/sheemeh/projects/meddaemon' },
  { repo: 'azra', root: '/home/sheemeh/projects/azra/azra' },
] }, { ts: ts++ });
const GPID = gp.projectId;
store.openElection('claude-azra-1', { projectId: GPID }, { ts: ts++ }, { curatorOnline: false, onlineParticipants: online });
expectErr('ELECTION_OPEN', () => store.openElection('claude-azra-1', { projectId: GPID }, { ts: ts++ }, { curatorOnline: false, onlineParticipants: online }));
expectErr('NOT_CURATOR', () => store.deleteProject('claude-meddaemon-1', { projectId: GPID })); // not curator/framework/user
store.deleteProject('user', { projectId: GPID });
assert.strictEqual(store.listProjects().projects.find((p) => p.id === GPID), undefined, 'deleted project is gone from disk + memory');
console.log('OK: open_election double-open guard + delete-project governance');

// ── 4j. relevance-scoped change-feed recipients (signal/noise) ────────────────
const np = store.createProject('claude-bukowski-1', { name: 'Noise Test', goal: 'g', curator: 'claude-bukowski-1', repos: [
  { repo: 'meddaemon', root: '/home/sheemeh/projects/meddaemon' },
  { repo: 'azra', root: '/home/sheemeh/projects/azra/azra' },
] }, { ts: ts++ });
const NPID = np.projectId;
const mbug = store.setEntry('claude-meddaemon-1', { projectId: NPID, repo: 'meddaemon', category: 'bugs', oneliner: 'framework bug', refs: ['meddaemon://sha/a'] }, { ts: ts++ });
const atask = store.setEntry('claude-azra-1', { projectId: NPID, repo: 'azra', category: 'tasks', oneliner: 'consumer task', refs: ['azra://sha/b'] }, { ts: ts++ });
store.linkBlockedOn('claude-azra-1', { projectId: NPID, entryId: atask.entryId, rel: 'blocked-on', targets: [`meddaemon://entry/${mbug.entryId}`] }, { ts: ts++ });

// self-edit to azra's own UNLINKED-to-others task, by azra → nobody else notified
const selfEdit = store.recipientsFor(NPID, { op: 'update', entryId: atask.entryId, by: 'claude-azra-1' });
assert.deepStrictEqual(selfEdit, [], 'self-edit of own dependent entry must not fan out to others');
// the LINK op itself notifies the target owner (meddaemon): "someone links to yours"
const onLink = store.recipientsFor(NPID, { op: 'link', entryId: atask.entryId, by: 'claude-azra-1' });
assert(onLink.includes('claude-meddaemon-1'), 'link op notifies the target owner');
// editing the depended-on bug notifies the dependent owner (azra)
const onBugEdit = store.recipientsFor(NPID, { op: 'update', entryId: mbug.entryId, by: 'claude-meddaemon-1' });
assert(onBugEdit.includes('claude-azra-1'), 'editing a dependency notifies its dependents');
// project-level op still reaches all participants (minus mutator)
const onRoadmap = store.recipientsFor(NPID, { op: 'set-roadmap', by: 'claude-bukowski-1' });
assert(onRoadmap.includes('claude-meddaemon-1') && onRoadmap.includes('claude-azra-1'), 'project-level events reach all participants');
console.log('OK: change-feed recipients relevance-scoped (self-edit silent, links/deps targeted, project-level broadcast)');

// ── 4k. soft prefix-validation of grounding refs ──────────────────────────────
const wBad = store.setEntry('claude-azra-1', { projectId: NPID, repo: 'azra', category: 'tasks', oneliner: 'unknown ref prefix', refs: ['azra-agent://sha/deadbeef'] }, { ts: ts++ });
assert(wBad.warnings && wBad.warnings.some((s) => /azra-agent/.test(s)), 'a ref with an unknown repo prefix warns (azra-agent not in this project)');
const wOk = store.setEntry('claude-azra-1', { projectId: NPID, repo: 'azra', category: 'tasks', oneliner: 'known ref prefix', refs: ['azra://sha/deadbeef'] }, { ts: ts++ });
assert(!wOk.warnings, 'a ref with a known repo prefix produces no prefix warning');
console.log('OK: soft prefix-validation warns on unknown repo prefixes, silent on known');

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

// ── 9. tips: the one category with a body (wikihow gotcha surface) ────────────
const tipBody = 'Symptom: broker hangs on SIGTERM.\nFix: bounce with SIGINT first, wait for "drained", THEN restart.\nNever kill -9 mid-corpus.';
const tip = store.setEntry('claude-azra-1', {
  projectId: NPID, repo: 'azra', category: 'tips',
  oneliner: 'How to bounce the broker without losing in-flight rows',
  refs: ['azra://docs/runbooks.md#broker-bounce'],
  tags: ['Broker', 'restart'], body: tipBody + '\n\n\n', // blank lines must collapse
}, { ts: ts++ });
assert(tip.ok && /^tip-\d+$/.test(tip.entryId), 'tip create returns tip-N id');

// body refused outside tips; refs + cap enforced for tips
expectErr('BODY_NOT_ALLOWED', () => store.setEntry('claude-azra-1', { projectId: NPID, repo: 'azra', category: 'tasks', oneliner: 'no body here', refs: ['azra://sha/c'], body: 'nope' }, { ts: ts++ }));
expectErr('BODY_TOO_LONG', () => store.setEntry('claude-azra-1', { projectId: NPID, repo: 'azra', category: 'tips', oneliner: 'too big', refs: ['azra://sha/c'], body: 'x'.repeat(1501) }, { ts: ts++ }));
expectErr('MISSING_REFS', () => store.setEntry('claude-azra-1', { projectId: NPID, repo: 'azra', category: 'tips', oneliner: 'no doc ref', body: 'orphan summary' }, { ts: ts++ }));

// list query: tag-filtered, body omitted, hasBody flagged, tags lowercased
const tipList = store.queryEntries('user', { projectId: NPID, category: 'tips', tag: 'broker' }).entries;
assert.strictEqual(tipList.length, 1, 'tag filter finds the tip');
assert.strictEqual(tipList[0].body, undefined, 'list results must omit the body');
assert.strictEqual(tipList[0].hasBody, true, 'list results flag hasBody');
assert.deepStrictEqual(tipList[0].tags, ['broker', 'restart'], 'tags lowercased');

// keyword query reaches into the body; entryId get returns it in full, blanks collapsed
assert.strictEqual(store.queryEntries('user', { projectId: NPID, q: 'sigterm' }).entries.length, 1, 'q matches body text');
const tipFull = store.queryEntries('user', { projectId: NPID, entryId: tip.entryId }).entries[0];
assert.strictEqual(tipFull.body, tipBody, 'entryId get returns the normalized body');

// digest stays titles-only — never leaks body lines
const tipDigest = store.digest('user', { projectId: NPID }).digest;
assert(tipDigest.includes('How to bounce the broker'), 'digest lists the tip title');
assert(!tipDigest.includes('SIGTERM'), 'digest must not include tip bodies');

// disk: body round-trips via four-space indent grammar, byte-stably
const tipsMd = fs.readFileSync(path.join(ROOT, NPID, 'tips.md'), 'utf-8');
assert(tipsMd.includes('    Symptom: broker hangs'), 'tips.md carries indented body lines');
assert.strictEqual(_internals.serializeCategory('tips', store.projects.get(NPID).name, _internals.parseCategory(tipsMd)), tipsMd, 'tips.md must re-serialize byte-identically');
const storeT = new DashboardStore({ root: ROOT });
assert.strictEqual(storeT.queryEntries('user', { projectId: NPID, entryId: tip.entryId }).entries[0].body, tipBody, 'tip body survives reload');
console.log('OK: tips carry capped bodies + tags, queryable, digest titles-only, byte-stable');

// ── 10. id watermark: no id reuse across delete/recreate eras or promotes ─────
const era1 = store.createProject('claude-azra-1', { name: 'Era Test', goal: 'g', repos: [{ repo: 'azra', root: '/home/sheemeh/projects/azra/azra' }] }, { ts: ts++ });
const e1a = store.setEntry('claude-azra-1', { projectId: era1.projectId, repo: 'azra', category: 'todos', oneliner: 'era one todo', refs: ['azra://sha/e1'] }, { ts: ts++ });
assert.strictEqual(e1a.entryId, 'todo-1');
store.deleteProject('claude-azra-1', { projectId: era1.projectId }, { ts: ts++ });
const era2 = store.createProject('claude-azra-1', { name: 'Era Test', goal: 'g2', repos: [{ repo: 'azra', root: '/home/sheemeh/projects/azra/azra' }] }, { ts: ts++ });
const e2a = store.setEntry('claude-azra-1', { projectId: era2.projectId, repo: 'azra', category: 'todos', oneliner: 'era two todo', refs: ['azra://sha/e2'] }, { ts: ts++ });
assert.strictEqual(e2a.entryId, 'todo-2', `recreated project must not re-issue todo-1 (got ${e2a.entryId})`);
// promote vacates task-N in its category; the next task must not reuse it
const pr1 = store.setEntry('claude-azra-1', { projectId: era2.projectId, repo: 'azra', category: 'tasks', oneliner: 'will be promoted', refs: ['azra://sha/e3'] }, { ts: ts++ });
store.promoteEntry('claude-azra-1', { projectId: era2.projectId, entryId: pr1.entryId, toCategory: 'bugs' }, { ts: ts++ });
const pr2 = store.setEntry('claude-azra-1', { projectId: era2.projectId, repo: 'azra', category: 'tasks', oneliner: 'must get fresh id', refs: ['azra://sha/e4'] }, { ts: ts++ });
assert.notStrictEqual(pr2.entryId, pr1.entryId, 'a promoted-away id must never be re-issued');
console.log('OK: id watermark survives delete/recreate eras and promote vacancies');

// ── 11. repo-residency multi-edit: same-host box-mates co-curate entries ───────
// Entries owned by claude-azra-agent-1 (host=azra-agent) are editable by ANY
// agent resident on that host — codex-azra-agent-1, claude-azra-agent-2, etc. —
// not just the single named owner. Residency keys off the id host segment (the
// SAME source on both sides), never the transport machine-host field.
const rp = store.createProject('claude-bukowski-1', { name: 'Residency Test', goal: 'g', curator: 'claude-bukowski-1', repos: [
  { repo: 'azra-agent', root: '/home/sheemeh/projects/azra-agent' },
] }, { ts: ts++ });
const RPID = rp.projectId;
// owner is minted from the repo-root basename → claude-azra-agent-1
const owned = store.setEntry('claude-azra-agent-1', { projectId: RPID, repo: 'azra-agent', category: 'tasks', oneliner: 'owner creates the entry', refs: ['azra-agent://sha/r1'] }, { ts: ts++ });
assert.strictEqual(store.queryEntries('user', { projectId: RPID, entryId: owned.entryId }).entries[0].owner, 'claude-azra-agent-1', 'entry owner is the host-1 id');
// THE PROOF: a different agent type on the SAME host edits the owner's entry.
const coEdit = store.setEntry('codex-azra-agent-1', { projectId: RPID, repo: 'azra-agent', category: 'tasks', oneliner: 'box-mate codex edits it', refs: ['azra-agent://sha/r2'], entryId: owned.entryId }, { ts: ts++ });
assert(coEdit.ok, 'codex-azra-agent-1 (same host) must set/update a claude-azra-agent-1-owned entry');
assert.strictEqual(store.queryEntries('user', { projectId: RPID, entryId: owned.entryId }).entries[0].oneliner, 'box-mate codex edits it', 'co-edit applied');
// box-mate can also close/promote/link
const coClose = store.closeEntry('codex-azra-agent-1', { projectId: RPID, entryId: owned.entryId }, { ts: ts++ });
assert(coClose.ok, 'same-host box-mate may close the entry');
// a higher-N same-host agent is also in-residency (claude-azra-agent-2)
const co2 = store.setEntry('claude-azra-agent-2', { projectId: RPID, repo: 'azra-agent', category: 'bugs', oneliner: 'agent-2 also resident', refs: ['azra-agent://sha/r3'] }, { ts: ts++ });
assert(co2.ok, 'claude-azra-agent-2 is resident on the same host and may write');
// NEGATIVE: a DIFFERENT-host agent is still rejected (no cross-host widening).
expectErr('NOT_RESPONSIBLE', () => store.setEntry('claude-meddaemon-1', { projectId: RPID, repo: 'azra-agent', category: 'bugs', oneliner: 'cross-host write', refs: ['azra-agent://sha/r4'] }, { ts: ts++ }));
// NEGATIVE: the flagged edge case — an id whose host SEGMENT differs (cwd
// basename "projects", even if it shares a machine host) is NOT in residency.
// Residency is the id segment, so claude-projects-3 stays scoped out.
expectErr('NOT_RESPONSIBLE', () => store.setEntry('claude-projects-3', { projectId: RPID, repo: 'azra-agent', category: 'bugs', oneliner: 'different id-segment host', refs: ['azra-agent://sha/r5'] }, { ts: ts++ }));
console.log('OK: repo-residency multi-edit — same-host box-mates co-curate, cross-host + off-segment rejected');

// ── 12. direct participant grants: reach co-tenant agents derivation can't ────
// codex-azra-agent-1 and claude-azra-agent-1 share one checkout root, so the
// repo map derives ONE owner and codex is invisible — hard-blocked from
// commenting. A curator grants it directly; the grant is stored separately and
// MUST survive a later map_repos re-derivation (the clobber regression).
const pp = store.createProject('claude-bukowski-1', { name: 'Grant Test', goal: 'g', curator: 'claude-meddaemon-1', repos: [
  { repo: 'meddaemon', root: '/home/sheemeh/projects/meddaemon' },
  { repo: 'azra-agent', root: '/home/sheemeh/projects/azra-agent' },
] }, { ts: ts++ });
const PPID = pp.projectId;
const aEntry = store.setEntry('claude-azra-agent-1', { projectId: PPID, repo: 'azra-agent', category: 'challenges', oneliner: 'chal-13 stand-in', refs: ['azra-agent://sha/c13'] }, { ts: ts++ });
// co-tenant codex is NOT a derived participant → comment blocked
expectErr('NOT_RESPONSIBLE', () => store.commentEntry('codex-azra-agent-1', { projectId: PPID, entryId: aEntry.entryId, text: 'before grant' }, { ts: ts++ }));
// non-curator cannot grant
expectErr('NOT_CURATOR', () => store.addParticipant('claude-azra-1', { projectId: PPID, agentId: 'codex-azra-agent-1' }, { ts: ts++ }));
// curator grants codex directly
const g1 = store.addParticipant('claude-meddaemon-1', { projectId: PPID, agentId: 'codex-azra-agent-1' }, { ts: ts++ });
assert(g1.ok && store.projects.get(PPID).participants.includes('codex-azra-agent-1'), 'grant adds codex to effective participants');
// now codex can comment (the chal-13 unblock)
assert(store.commentEntry('codex-azra-agent-1', { projectId: PPID, entryId: aEntry.entryId, text: 'after grant' }, { ts: ts++ }).ok, 'granted co-tenant may comment');
// THE CLOBBER REGRESSION: a later map_repos re-derives, grant must survive
store.mapRepos('claude-meddaemon-1', { projectId: PPID, repos: [
  { repo: 'meddaemon', root: '/home/sheemeh/projects/meddaemon' },
  { repo: 'azra-agent', root: '/home/sheemeh/projects/azra-agent' },
  { repo: 'azra', root: '/home/sheemeh/projects/azra' },
] }, { ts: ts++ });
assert(store.projects.get(PPID).participants.includes('codex-azra-agent-1'), 'direct grant survives a map_repos re-derivation (no clobber)');
assert(store.commentEntry('codex-azra-agent-1', { projectId: PPID, entryId: aEntry.entryId, text: 'after remap' }, { ts: ts++ }).ok, 'codex still a participant after remap');
// grant survives a fresh reload from disk (separate persistence)
const storeG = new DashboardStore({ root: ROOT });
assert(storeG.projects.get(PPID).participants.includes('codex-azra-agent-1'), 'grant persists across reload (separate grants: line in meta)');
// remove revokes the DIRECT grant → comment blocked again
const rm = store.removeParticipant('claude-meddaemon-1', { projectId: PPID, agentId: 'codex-azra-agent-1' }, { ts: ts++ });
assert(rm.ok && rm.stillParticipantViaRepo === false, 'remove revokes the grant; codex not derived');
expectErr('NOT_RESPONSIBLE', () => store.commentEntry('codex-azra-agent-1', { projectId: PPID, entryId: aEntry.entryId, text: 'after remove' }, { ts: ts++ }));
// precedence: removing a DERIVED owner via remove_participant does NOT drop it
const rmDerived = store.removeParticipant('claude-meddaemon-1', { projectId: PPID, agentId: 'claude-azra-agent-1' }, { ts: ts++ });
assert(rmDerived.stillParticipantViaRepo === true, 'remove_participant cannot drop a repo-derived participant (use map_repos)');
assert(store.projects.get(PPID).participants.includes('claude-azra-agent-1'), 'derived owner remains a participant after a no-op direct remove');
console.log('OK: direct participant grants — unblock co-tenant, survive remap+reload, remove revokes, derived owners protected');

console.log('OK: dashboard-store smoke passed');
process.exit(0);
