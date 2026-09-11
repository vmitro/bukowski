// src/dashboard/TatrStore.js — tatr-style backend for the dashboard (spike).
//
// A DashboardStore whose on-disk canonical form is ONE DIRECTORY PER ENTRY
// (`<project>/entries/<id>/TASK.md`, YAML-frontmatter + markdown body), git-
// committed on every mutation, instead of one Markdown file per category.
//
// Why: per-entry files merge conflict-free across branches/hosts (git IS the
// cross-host sync — the intended fix for dashboard bug-4), and advisory-only
// ownership removes the owner-offline write deadlock (meddaemon-azra todo-50).
// See docs/adr/0001-tatr-backed-dashboard-store.md.
//
// SPIKE SCOPE (isolated mode, single host):
//   - Reuses the base in-memory model, all mutators, validation, id-gen, events.
//   - Overrides ONLY persistence layout + load + the residency gate; adds git.
//   - Still writes the legacy <category>.md via super (dual-write) so rollback
//     to JsonMarkdownStore is trivial and `cat entries/*/TASK.md` both work.
//   - Entry dir = the entry id (bug-4). Cross-host HUID `-<host>` suffixing to
//     avoid independent-mint collisions is the Phase-3 (bridged) change.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { atomicWrite } = require('./atomicWrite');
const { DashboardStore, CATEGORIES } = require('./DashboardStore');

// ─── TASK.md (de)serialization ──────────────────────────────────────────────
// Frontmatter carries every structured field; the one-liner is the H1 and the
// body (tips) is the markdown after it. Round-trips to the base entry shape.

function parseLink(s) {
  const i = s.indexOf(':');
  if (i === -1) return { rel: 'blocked-on', target: s };
  return { rel: s.slice(0, i), target: s.slice(i + 1) };
}

function serializeTask(e, category) {
  const fm = [
    `id: ${e.id}`,
    `category: ${category}`,
    `status: ${e.status}`,
    `owner: ${e.owner || ''}`,
    `priority: ${e.priority ?? 0}`,
  ];
  if (e.repo) fm.push(`repo: ${e.repo}`);
  if (e.refs && e.refs.length) fm.push(`refs: ${e.refs.join(', ')}`);
  if (e.links && e.links.length) fm.push(`links: ${e.links.map((l) => `${l.rel}:${l.target}`).join(', ')}`);
  if (e.causal_parent) fm.push(`causal_parent: ${e.causal_parent}`);
  if (e.tags && e.tags.length) fm.push(`tags: ${e.tags.join(', ')}`);
  fm.push(`ts: ${e.ts}`);
  let s = `---\n${fm.join('\n')}\n---\n\n# ${e.oneliner}\n`;
  if (e.body) s += `\n${e.body}\n`;
  return s;
}

function parseTask(text) {
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return { entry: null, category: null };
  let i = 1;
  const fm = {};
  for (; i < lines.length; i++) {
    if (lines[i].trim() === '---') { i++; break; }
    const idx = lines[i].indexOf(':');
    if (idx === -1) continue;
    fm[lines[i].slice(0, idx).trim()] = lines[i].slice(idx + 1).trim();
  }
  // body: first `# ` line is the one-liner; the rest (trimmed) is the body.
  let oneliner = '';
  const bodyLines = [];
  for (; i < lines.length; i++) {
    if (!oneliner && lines[i].startsWith('# ')) { oneliner = lines[i].slice(2).trim(); continue; }
    if (oneliner) bodyLines.push(lines[i]);
  }
  const body = bodyLines.join('\n').trim() || null;
  const list = (v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
  const entry = {
    id: fm.id,
    status: fm.status || 'open',
    oneliner,
    refs: list(fm.refs),
    links: list(fm.links).map(parseLink),
    causal_parent: fm.causal_parent || null,
    repo: fm.repo || null,
    tags: list(fm.tags),
    body,
    ts: fm.ts ? Number(fm.ts) : Date.now(),
    owner: fm.owner || null,
    priority: fm.priority != null ? Number(fm.priority) : 0,
  };
  return { entry, category: fm.category };
}

// ─── Store ──────────────────────────────────────────────────────────────────

class TatrStore extends DashboardStore {
  constructor(opts = {}) {
    // Isolate from the default JsonMarkdownStore root: a --with-tatr session
    // uses its OWN dashboard tree (~/.bukowski/dashboard-tatr) so it never
    // co-mingles with / git-inits the shared live dashboard. Override via
    // opts.root (tests) or BUKOWSKI_TATR_ROOT.
    const root = opts.root
      || process.env.BUKOWSKI_TATR_ROOT
      || path.join(os.homedir(), '.bukowski', 'dashboard-tatr');
    super({ ...opts, root }); // base ctor runs _loadAll → our overridden _loadProject
    this._gitInit();
  }

  _entriesDir(id) { return path.join(this._projDir(id), 'entries'); }

  // Advisory ownership: no host-residency write-gate. Concurrency is resolved
  // by git merge (per-entry files), not single-writer routing — this is what
  // dissolves the todo-50 owner-offline deadlock. `owner` still rides the
  // frontmatter and git-blame for provenance.
  _sameResidency() { return true; }

  // Load: prefer the native per-entry dirs; if absent, the base loader has
  // already read the legacy <category>.md files into memory — the EXPLODE then
  // happens on the next _persistProject (they fan out to entries/). That is the
  // migration path, no separate import step.
  _loadProject(id) {
    const p = super._loadProject(id);
    const edir = this._entriesDir(id);
    if (fs.existsSync(edir)) {
      for (const cat of CATEGORIES) p.categories[cat] = [];
      let dirents = [];
      try { dirents = fs.readdirSync(edir, { withFileTypes: true }); } catch { /* none */ }
      for (const d of dirents) {
        if (!d.isDirectory()) continue;
        const f = path.join(edir, d.name, 'TASK.md');
        if (!fs.existsSync(f)) continue;
        try {
          const { entry, category } = parseTask(fs.readFileSync(f, 'utf-8'));
          if (entry && entry.id && CATEGORIES.includes(category)) p.categories[category].push(entry);
        } catch { /* skip malformed TASK.md */ }
      }
      this.projects.set(id, p);
    }
    return p;
  }

  // Persist: keep the base writes (meta/roadmap/election/audit + legacy
  // <category>.md mirror for rollback), then fan out every entry to its own
  // dir, prune removed/promoted ids, and git-commit the whole project.
  _persistProject(p) {
    super._persistProject(p);
    const edir = this._entriesDir(p.id);
    fs.mkdirSync(edir, { recursive: true, mode: 0o700 });
    const want = new Set();
    for (const cat of CATEGORIES) {
      for (const e of p.categories[cat] || []) {
        want.add(e.id);
        const d = path.join(edir, e.id);
        fs.mkdirSync(d, { recursive: true, mode: 0o700 });
        atomicWrite(path.join(d, 'TASK.md'), serializeTask(e, cat));
      }
    }
    // prune dirs for entries that no longer exist (deleted / promoted away)
    let dirents = [];
    try { dirents = fs.readdirSync(edir, { withFileTypes: true }); } catch { /* none */ }
    for (const d of dirents) {
      if (d.isDirectory() && !want.has(d.name)) {
        try { fs.rmSync(path.join(edir, d.name), { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
    this._gitCommit(p.id);
  }

  // ── git (best-effort; a missing git binary must never break the dashboard) ──

  _git(args) {
    return execFileSync('git', ['-C', this.root, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
  }

  _gitInit() {
    try {
      if (!fs.existsSync(path.join(this.root, '.git'))) {
        this._git(['init', '-q']);
      }
      // Ensure a commit identity exists (commit fails otherwise on fresh boxes).
      try { this._git(['config', 'user.email']); } catch { this._git(['config', 'user.email', 'bukowski@localhost']); }
      try { this._git(['config', 'user.name']); } catch { this._git(['config', 'user.name', 'bukowski-dashboard']); }
    } catch { /* git absent → run without version control */ }
  }

  _gitCommit(projectId) {
    try {
      this._git(['add', '-A']);
      this._git(['commit', '-q', '-m', `dashboard(${projectId}): sync`]);
    } catch { /* nothing to commit, or git absent — fine */ }
  }
}

module.exports = { TatrStore, _internals: { serializeTask, parseTask } };
