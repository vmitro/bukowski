#!/usr/bin/env node
// Port a legacy JsonMarkdown dashboard (one .md file per category) to tatr form
// (one dir per entry: entries/<id>/TASK.md + git history), by reusing
// TatrStore's explode-on-persist. Read-only on the source; writes a fresh dst.
//
// Usage:
//   node scripts/ops/port-dashboard-to-tatr.js [srcRoot] [dstRoot] [--force]
// Defaults: src ~/.bukowski/dashboard, dst ~/.bukowski/dashboard-tatr
//
// Portable: run on any box (netcup, laptop) — point it at that box's legacy
// dashboard root. Idempotent with --force (rebuilds dst from scratch).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { TatrStore } = require(path.join(__dirname, '..', '..', 'src', 'dashboard', 'TatrStore'));

const args = process.argv.slice(2);
const force = args.includes('--force');
const pos = args.filter((a) => !a.startsWith('--'));
const src = pos[0] || path.join(os.homedir(), '.bukowski', 'dashboard');
const dst = pos[1] || path.join(os.homedir(), '.bukowski', 'dashboard-tatr');

if (!fs.existsSync(path.join(src, 'index.md')) && !fs.readdirSync(src).some((d) => fs.existsSync(path.join(src, d, 'meta.md')))) {
  console.error(`[port] no legacy dashboard at ${src} (expected project dirs with meta.md)`);
  process.exit(1);
}
if (fs.existsSync(dst) && !force) {
  console.error(`[port] dst exists: ${dst}\n[port] pass --force to rebuild it from scratch`);
  process.exit(1);
}

console.log(`[port] src (legacy, read-only): ${src}`);
console.log(`[port] dst (tatr):              ${dst}`);

// 1) Seed dst from a copy of the legacy tree (meta / <category>.md / roadmap /
//    _election / _audit / _idseq / index), then strip any prior tatr+git so we
//    rebuild deterministically.
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
fs.rmSync(path.join(dst, '.git'), { recursive: true, force: true });
for (const d of fs.readdirSync(dst, { withFileTypes: true })) {
  if (d.isDirectory()) fs.rmSync(path.join(dst, d.name, 'entries'), { recursive: true, force: true });
}

// 2) Load via TatrStore (base loader reads the legacy <category>.md into memory
//    because no entries/ dirs exist), then persist each project → fan out to
//    entries/<id>/TASK.md and git-commit. This IS the explode.
const store = new TatrStore({ root: dst });
let projects = 0;
let entries = 0;
const perProject = [];
for (const [id, p] of store.projects) {
  projects++;
  let n = 0;
  for (const cat of Object.keys(p.categories)) n += (p.categories[cat] || []).length;
  entries += n;
  store._persistProject(p); // explode + git commit
  perProject.push(`${id}: ${n} entr${n === 1 ? 'y' : 'ies'}`);
}

// 3) Summary
let commits = 0;
try { commits = execFileSync('git', ['-C', dst, 'log', '--oneline'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length; } catch { /* no git */ }
let taskFiles = 0;
const countTasks = (dir) => {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, d.name);
    if (d.isDirectory()) countTasks(f);
    else if (d.name === 'TASK.md') taskFiles++;
  }
};
try { countTasks(dst); } catch { /* ignore */ }

console.log('[port] ---');
perProject.forEach((l) => console.log('[port]   ' + l));
console.log(`[port] done: ${projects} project(s), ${entries} entr(y/ies) → ${taskFiles} TASK.md, ${commits} git commit(s)`);
console.log(`[port] verify: git -C ${dst} log --oneline | head; find ${dst} -name TASK.md | head`);
