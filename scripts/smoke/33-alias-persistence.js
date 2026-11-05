#!/usr/bin/env node
// Regression: a self-chosen name survives the respawn it exists to outlive.
//
// Follow-up to bug-31. That fix made a live claim FEDERATE; it did not make one
// PERSIST, and the claim map was in-memory, so every pane respawn wiped every
// name — the identity agents are told to prefer precisely *because* seat ids
// churn did not survive a restart. Owner call 2026-11-05: persist, scoped
// per-instance (cwd-keyed), with a TTL.
//
// The dangerous half is shadowing. A durable claim could outlive its agent and
// then resolve to a dead id, or worse, be handed a name that now belongs to
// somebody live — the bug-21 failure mode made permanent. So a loaded claim is
// a RECORD, not a binding: it resolves only once the agent it names exists
// again, and a live claimant always beats a stale record.
//
// Pure/fast: real MCPServer dispatch + real AliasStore on a temp root.

const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..', '..');
const { MCPServer } = require(path.join(ROOT, 'src', 'mcp', 'MCPServer'));
const { AliasStore } = require(path.join(ROOT, 'src', 'mcp', 'AliasStore'));

let failed = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${msg}`);
  if (!cond) failed++;
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-store-'));
process.env.BUKOWSKI_ALIAS_ROOT = tmpRoot;

// A fresh server standing in for one instance life. Same cwd => same store.
function instance(agents) {
  const list = agents.slice();
  const session = {
    id: 's1',
    getAgent: (id) => list.find((a) => a.id === id) || null,
    getAllAgents: () => list,
  };
  const s = new MCPServer(session, null, null, null);
  s.externalAgents = new Map();
  s.messageQueues = new Map();
  return s;
}
const pane = { id: 'claude-1', name: 'claude', type: 'claude', pty: { pid: 1 } };

console.log('1. a claim is written through to disk');
const a = instance([pane]);
const claim = a._claimAlias('claude-1', 'dispatcher-prime');
ok(claim.ok === true, 'the claim succeeds');
ok(claim.persisted === true, 'and reports that it was persisted');
const files = fs.readdirSync(tmpRoot).filter((f) => f.endsWith('.json'));
ok(files.length === 1, 'exactly one store file for this instance');
const onDisk = JSON.parse(fs.readFileSync(path.join(tmpRoot, files[0]), 'utf8'));
ok(onDisk.claims['dispatcher-prime']?.agentId === 'claude-1', 'the record names the agent');
ok(/^600$/.test((fs.statSync(path.join(tmpRoot, files[0])).mode & 0o777).toString(8)),
  'stored 0600 — a claim is not world-readable');

console.log('2. it survives a respawn of the same seat');
// New process, same cwd, pane keeps its local id. This is the headline.
const b = instance([pane]);
ok(b.agentAliases.size === 0, 'nothing is bound before anything asks');
ok(b._resolveAlias('dispatcher-prime') === 'claude-1', 'the name resolves again after restart');
ok(b.getClaimedAliases('claude-1').includes('dispatcher-prime'),
  'and the roster reports it, so it federates without a re-claim');

console.log('3. a record whose agent is NOT running resolves to nothing');
// The anti-shadow invariant. A dead id must never be handed back as routable.
const c = instance([]);
ok(c._resolveAlias('dispatcher-prime') === null, 'no live agent, no resolution');
ok(c.agentAliases.size === 0, 'and it is not bound speculatively');

console.log('4. a live claimant beats a stale record, with a warning');
const d = instance([{ id: 'codex-1', name: 'codex', type: 'codex', pty: { pid: 2 } }]);
const steal = d._claimAlias('codex-1', 'dispatcher-prime');
ok(steal.ok === true, 'a different live agent may take the name');
ok(steal.tookOverStaleClaim === 'claude-1', 'the displaced holder is named');
ok(/stale persisted claim/.test(steal.warning || ''), 'and it is reported, not silent');
ok(d._resolveAlias('dispatcher-prime') === 'codex-1', 'the name now routes to the live agent');

console.log('5. a LIVE holder is still refused (unchanged)');
const e = instance([pane, { id: 'codex-1', name: 'codex', type: 'codex', pty: { pid: 2 } }]);
e._claimAlias('claude-1', 'taken-name');
const refused = e._claimAlias('codex-1', 'taken-name');
ok(refused.ok === false && /is held by claude-1/.test(refused.error || ''),
  'contested name refused while its holder is alive');

console.log('6. re-claim replaces, on disk as well as in memory');
const f = instance([pane]);
f._claimAlias('claude-1', 'first-name');
f._claimAlias('claude-1', 'second-name');
ok(f._resolveAlias('second-name') === 'claude-1', 'the new name resolves');
ok(f._resolveAlias('first-name') === null, 'the old one does not');
const g = instance([pane]);
ok(g._resolveAlias('first-name') === null, 'and the old one did not survive to disk either');
ok(g._resolveAlias('second-name') === 'claude-1', 'while the new one did');

console.log('7. release gives the name back');
const h = instance([pane]);
const dropped = h._releaseAliases('claude-1');
ok(dropped.includes('second-name'), 'release reports what it dropped');
ok(instance([pane])._resolveAlias('second-name') === null, 'and it is gone from disk');

console.log('8. an expired claim is pruned on load');
const store = new AliasStore({ cwd: process.cwd() });
store.save(new Map([['ancient', {
  agentId: 'claude-1', agentType: 'claude',
  claimedAt: 0, lastSeen: Date.now() - 15 * 86400000, // 15d > 14d default
}]]));
ok(store.load().has('ancient') === false, 'past the TTL it is dropped');
store.save(new Map([['recent', {
  agentId: 'claude-1', agentType: 'claude',
  claimedAt: 0, lastSeen: Date.now() - 1 * 86400000,
}]]));
ok(store.load().has('recent') === true, 'inside the TTL it is kept');

console.log('9. a corrupt or missing store never stops a boot');
const bad = new AliasStore({ cwd: '/nonexistent-instance-xyz' });
ok(bad.load().size === 0, 'a missing file loads as no claims');
fs.writeFileSync(path.join(tmpRoot, 'broken-deadbeef.json'), '{not json');
const broken = new AliasStore({ cwd: process.cwd(), root: tmpRoot });
broken.file = path.join(tmpRoot, 'broken-deadbeef.json');
ok(broken.load().size === 0, 'a corrupt file loads as no claims, no throw');

console.log('10. a record can never resurrect a name that is now a real agent id');
const store2 = new AliasStore({ cwd: process.cwd() });
store2.save(new Map([['codex-9', {
  agentId: 'claude-1', agentType: 'claude', claimedAt: Date.now(), lastSeen: Date.now(),
}]]));
const i = instance([pane, { id: 'codex-9', name: 'codex', type: 'codex', pty: { pid: 3 } }]);
ok(i._resolveAlias('codex-9') !== 'claude-1',
  'a stale record does not divert a name that is now a live agent id');

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${failed === 0 ? 'OK' : 'FAILED'}: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
