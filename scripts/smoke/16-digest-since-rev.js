#!/usr/bin/env node
// Regression: digest{sinceRev} must actually be a delta.
//
//   bug-12  The filter read `(e.ts || 0) > sinceRev`. entry.ts is a ms epoch
//           (~1.79e12); sinceRev is a project rev counter (thousands). No
//           plausible rev ever exceeds an epoch, so the predicate was true for
//           every entry and the "delta" was the entire board. Every change
//           notice ends with `dashboard_digest{sinceRev:N-1} for details`, so
//           the miss was fleet-wide — it is what made a meddaemon-azra digest
//           160KB. Entries now carry the rev their last change landed at.
//
// Runs against an isolated store root, so the live board is never touched.

const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bukowski-digest-rev-'));
process.env.BUKOWSKI_DASHBOARD_ROOT = root;
const { DashboardStore } = require(path.join(__dirname, '..', '..', 'src', 'dashboard', 'DashboardStore'));

let failed = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${msg}`);
  if (!cond) failed++;
};

function freshStore() {
  const s = new DashboardStore({ root });
  s.createProject('claude-alpha-1', { name: 'dig' + Math.random().toString(36).slice(2, 8), goal: 'g' });
  const pid = [...s.projects.keys()].pop();
  s.mapRepos('claude-alpha-1', { projectId: pid, repos: [{ repo: 'alpha', root: '/home/x/projects/alpha' }] });
  return { s, pid };
}
const file = (s, pid, oneliner) => s.setEntry('claude-alpha-1', {
  projectId: pid, repo: 'alpha', category: 'bugs', oneliner, refs: ['alpha://sha/1'],
}).entryId;
const dig = (s, pid, sinceRev) => s.digest('claude-alpha-1', { projectId: pid, sinceRev }).digest;

// ── 1. The delta is a delta ─────────────────────────────────────────────────
{
  const { s, pid } = freshStore();
  const old1 = file(s, pid, 'old one');
  const old2 = file(s, pid, 'old two');
  const revBefore = s.projects.get(pid).rev;
  const fresh = file(s, pid, 'brand new');

  const full = dig(s, pid);
  ok(full.includes(old1) && full.includes(old2) && full.includes(fresh), 'no sinceRev returns the whole board');

  // This is the exact call every change notice suggests: sinceRev = rev - 1.
  const delta = dig(s, pid, revBefore);
  ok(delta.includes(fresh), 'delta carries the entry that just changed');
  ok(!delta.includes(old1) && !delta.includes(old2), 'delta drops entries untouched since sinceRev');

  ok(!dig(s, pid, s.projects.get(pid).rev).includes(fresh), 'sinceRev at head is empty');
  ok(dig(s, pid, 999999).split('\n').filter((l) => l.startsWith('- ')).length === 0,
    'sinceRev past head lists nothing');
}

// ── 2. Every entry-touching op restamps the rev ─────────────────────────────
{
  const { s, pid } = freshStore();
  const id = file(s, pid, 'touch me');
  for (const [label, op] of [
    ['update', () => s.setEntry('claude-alpha-1', { projectId: pid, entryId: id, oneliner: 'touched', refs: ['alpha://sha/1'] })],
    ['comment', () => s.commentEntry('claude-alpha-1', { projectId: pid, entryId: id, text: 'note' })],
    ['link', () => s.linkBlockedOn('claude-alpha-1', { projectId: pid, entryId: id, targets: ['alpha://sha/2'] })],
    ['close', () => s.closeEntry('claude-alpha-1', { projectId: pid, entryId: id, status: 'closed' })],
  ]) {
    const before = s.projects.get(pid).rev;
    op();
    ok(dig(s, pid, before).includes(id), `${label} makes the entry show up in the delta`);
  }

  // promote renames the entry and moves it between categories; the rev must
  // follow it to its NEW home, which is the category _mutate is told about.
  const before = s.projects.get(pid).rev;
  const promoted = s.promoteEntry('claude-alpha-1', { projectId: pid, entryId: id, toCategory: 'tasks' }).entryId;
  const d = dig(s, pid, before);
  ok(d.includes(promoted), 'promote stamps the rev in the destination category');
  ok(d.includes('## tasks') && !d.includes('## bugs'), 'promoted entry shows only under its new category');
}

// ── 3. The rev survives the markdown round-trip ─────────────────────────────
{
  const { s, pid } = freshStore();
  file(s, pid, 'persisted');
  const before = s.projects.get(pid).rev;
  const id = file(s, pid, 'after the mark');

  const reread = new DashboardStore({ root });
  const d = reread.digest('claude-alpha-1', { projectId: pid, sinceRev: before });
  ok(d.digest.includes(id), 'a second store reads the stamped rev back from markdown');
  ok(!d.digest.includes('persisted'), 'the reloaded delta still excludes older entries');
}

fs.rmSync(root, { recursive: true, force: true });

if (failed > 0) {
  console.log(`${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('digest-since-rev OK');
