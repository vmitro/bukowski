#!/usr/bin/env node
// Regression: entry ownership — who may write an entry, and how it changes hands.
//
// Two defects this pins down, both found live on meddaemon-azra:
//
//   bug-10  setEntry authorized the UPDATE path against _ownerForRepo(args.repo)
//           — the repo the CALLER passed — instead of the entry's own repo.
//           Declaring a repo you own let you rewrite anyone's entry; declaring
//           the entry's real repo got you denied. Every sibling mutator
//           (close/promote/link) already gated on entry.owner; setEntry did not.
//
//   bug-11  An entry's owner is derived from its repo at create time and no
//           argument ever set it again — the update branch wrote oneliner,
//           refs, status, body, tags and ts, never owner or repo. Work that
//           moved between boxes kept notifying and gating against the wrong
//           agent, with no way to hand it over.
//
// Runs against an isolated store root, so the live board is never touched.

const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bukowski-entry-own-'));
process.env.BUKOWSKI_DASHBOARD_ROOT = root;
const { DashboardStore } = require(path.join(__dirname, '..', '..', 'src', 'dashboard', 'DashboardStore'));

let failed = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${msg}`);
  if (!cond) failed++;
};
const code = (fn) => {
  try { fn(); return null; } catch (err) {
    const m = /DASHBOARD_ERROR (\{.*\})/s.exec(err.message);
    return m ? JSON.parse(m[1]).code : err.message;
  }
};

function freshStore() {
  const s = new DashboardStore({ root });
  s.createProject('claude-alpha-1', { name: 'own' + Math.random().toString(36).slice(2, 8), goal: 'g' });
  const pid = [...s.projects.keys()].pop();
  s.mapRepos('claude-alpha-1', { projectId: pid, repos: [
    { repo: 'alpha', root: '/home/x/projects/alpha' },
    { repo: 'beta', root: '/home/x/projects/beta' },
  ] });
  return { s, pid };
}

// beta's owner files an entry on beta; alpha is a stranger to it.
function withBetaEntry() {
  const { s, pid } = freshStore();
  const { entryId } = s.setEntry('claude-beta-1', {
    projectId: pid, repo: 'beta', category: 'bugs', oneliner: 'beta bug', refs: ['beta://sha/1'],
  });
  const get = () => s.queryEntries('claude-alpha-1', { projectId: pid, entryId }).entries[0];
  return { s, pid, entryId, get };
}

console.log('bug-10: setEntry must authorize against the ENTRY, not the caller\'s claim');
{
  const { s, pid, entryId, get } = withBetaEntry();
  ok(get().owner === 'claude-beta-1' && get().repo === 'beta', 'entry is owned by claude-beta-1 on repo beta');

  // The bug: alpha declares a repo IT owns and edits beta's entry anyway.
  const c1 = code(() => s.setEntry('claude-alpha-1', {
    projectId: pid, entryId, repo: 'alpha', oneliner: 'EDITED BY ALPHA', refs: ['alpha://sha/9'],
  }));
  ok(c1 === 'NOT_RESPONSIBLE', `stranger declaring its own repo is refused (got ${c1})`);
  ok(get().oneliner === 'beta bug', 'entry content survived the refused write');

  // The inverse: declaring the entry's REAL repo used to be the denied case.
  const c2 = code(() => s.setEntry('claude-alpha-1', {
    projectId: pid, entryId, repo: 'beta', oneliner: 'EDITED BY ALPHA', refs: ['beta://sha/9'],
  }));
  ok(c2 === 'NOT_RESPONSIBLE', `stranger declaring the true repo is refused too (got ${c2})`);

  // A resident of the owner's host still writes normally.
  const c3 = code(() => s.setEntry('claude-beta-1', {
    projectId: pid, entryId, repo: 'beta', oneliner: 'owner edit', refs: ['beta://sha/2'],
  }));
  ok(c3 === null && get().oneliner === 'owner edit', 'owner-host resident still writes');

  // Mismatched repo from an authorized caller must not silently re-file the
  // entry: that is how task-137 changed repo without anyone asking.
  const c4 = code(() => s.setEntry('claude-beta-1', {
    projectId: pid, entryId, repo: 'alpha', oneliner: 'sneaky move', refs: ['beta://sha/3'],
  }));
  ok(c4 === 'NOT_RESPONSIBLE', `owner passing a foreign repo is refused, not silently applied (got ${c4})`);
  ok(get().repo === 'beta' && get().owner === 'claude-beta-1', 'repo/owner unchanged by the refused write');
}

console.log('bug-11: an entry can change hands');
{
  const { s, pid, entryId, get } = withBetaEntry();

  // Strangers cannot take it. claude-gamma-1 is resident on neither repo and
  // is not the curator — alpha created the project, so alpha IS the curator
  // and is allowed by the deadlock route exercised further down.
  const grab = code(() => s.transferEntry('claude-gamma-1', { projectId: pid, entryId, toRepo: 'alpha' }));
  ok(grab === 'NOT_RESPONSIBLE', `a stranger cannot pull an entry to itself (got ${grab})`);

  // The giving side hands it over.
  const r = s.transferEntry('claude-beta-1', { projectId: pid, entryId, toRepo: 'alpha' });
  ok(r.owner === 'claude-alpha-1' && r.repo === 'alpha', 'owner follows the repo on transfer');
  ok(get().owner === 'claude-alpha-1' && get().repo === 'alpha', 'transfer is visible on the entry');
  ok(r.unchanged === false, 'a real transfer reports unchanged:false');

  // The new owner writes; the old one no longer can.
  ok(code(() => s.setEntry('claude-alpha-1', {
    projectId: pid, entryId, repo: 'alpha', oneliner: 'now mine', refs: ['alpha://sha/1'],
  })) === null, 'new owner may write the entry');
  ok(code(() => s.setEntry('claude-beta-1', {
    projectId: pid, entryId, repo: 'beta', oneliner: 'still mine?', refs: ['beta://sha/4'],
  })) === 'NOT_RESPONSIBLE', 'former owner may no longer write it');

  // Re-transferring to where it already is must not bump rev or broadcast —
  // the remove-participant no-op-that-still-woke-everyone failure (bug-13).
  const revBefore = s.projects.get(pid).rev;
  const noop = s.transferEntry('claude-alpha-1', { projectId: pid, entryId, toRepo: 'alpha' });
  ok(noop.unchanged === true, 'a transfer to the current repo reports unchanged:true');
  ok(s.projects.get(pid).rev === revBefore, 'a no-op transfer does not bump rev');

  // An unmapped repo is refused rather than minting a phantom owner.
  ok(code(() => s.transferEntry('claude-alpha-1', { projectId: pid, entryId, toRepo: 'nope' })) === 'BAD_CATEGORY',
    'transfer to an unmapped repo is refused');

  // Ownership must survive the markdown round-trip, or the transfer is a lie.
  const reread = new DashboardStore({ root });
  const rt = reread.queryEntries('claude-alpha-1', { projectId: pid, entryId }).entries[0];
  ok(rt.owner === 'claude-alpha-1' && rt.repo === 'alpha', 'transferred owner/repo survive reload');
}

console.log('bug-11: the curator is the exit from an offline owner');
{
  const { s, pid, entryId, get } = withBetaEntry();
  // claude-alpha-1 created the project, so it is the curator — and it is a
  // stranger to beta's entry. Without this route, an entry owned by a host
  // whose seat is offline can never be reassigned (tip-7 deadlock).
  ok(s.projects.get(pid).curator === 'claude-alpha-1', 'alpha is the project curator');
  const r = s.transferEntry('claude-alpha-1', { projectId: pid, entryId, toRepo: 'alpha' });
  ok(r.owner === 'claude-alpha-1', 'curator may reassign an entry it does not own');
  ok(get().owner === 'claude-alpha-1', 'curator transfer lands on the entry');
}

fs.rmSync(root, { recursive: true, force: true });

if (failed > 0) {
  console.log(`${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('dashboard-entry-ownership OK');
