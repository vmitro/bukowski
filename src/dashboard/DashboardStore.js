// src/dashboard/DashboardStore.js - canonical store for the FIPA-native project
// dashboard. Pure data + governance: zero MCP/FIPA knowledge, so it's unit
// testable in isolation. One instance is owned by the curator's MCPServer; all
// mutations funnel through it (single writer by routing), so no lockfile is
// needed even though the on-disk form is a shared, human-cat-able directory.
//
// LOAD-BEARING INVARIANTS (see plan spicy-humming-wigderson.md):
//   - Pointers, not content: an entry is a <=80-char one-liner + grounding refs.
//     There is structurally no field to paste a body into — with ONE deliberate
//     exception: `tips` entries carry a capped body (wikihow-style summary;
//     the referenced doc stays canonical). See MAX_TIP_BODY.
//   - Human-readable canonical form: one Markdown file per category, round-trips
//     byte-stably so concurrent/hand edits produce minimal diffs.
//   - Reuse the existing trace primitive: refs and the audit log carry FIPA
//     conversationId / message id / timestamp verbatim.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWrite } = require('./atomicWrite');
const { hostFromCwd } = require('../utils/host');

const CATEGORIES = ['description', 'challenges', 'tasks', 'todos', 'nicetohaves', 'bugs', 'adrs', 'tips'];
const CATEGORY_PREFIX = {
  description: 'desc', challenges: 'chal', tasks: 'task',
  todos: 'todo', nicetohaves: 'nice', bugs: 'bug', adrs: 'adr', tips: 'tip',
};
// Categories whose entries must carry >=1 grounding ref (actionable work that
// points at a durable artifact). `description` is narrative and exempt.
// `tips` requires refs too: the body is a summary, the referenced doc stays
// canonical.
const ACTIONABLE = new Set(['challenges', 'tasks', 'todos', 'nicetohaves', 'bugs', 'adrs', 'tips']);
const VALID_STATUS = new Set(['open', 'in_progress', 'closed', 'wontfix', 'promoted']);
const MAX_ONELINER = 80;
// `tips` is the one category with a body (wikihow-style how-to/gotcha summary,
// queryable cross-repo). Capped so tips.md stays greppable and the dashboard's
// pointers-not-content invariant bends without breaking.
const MAX_TIP_BODY = 1500;
const DEFAULT_CURATOR = 'claude-bukowski-1';
const ROADMAP_EXCLUDED = new Set(['claude-bukowski-1', 'claude-projects-1']);

/** Build a tagged Error the MCP layer surfaces verbatim as an isError block. */
function derr(code, message, detail) {
  return new Error('DASHBOARD_ERROR ' + JSON.stringify({ code, message, detail }));
}

/** scheme of a logical ref: meddaemon://sha/x -> "meddaemon", conv:y -> "conv". */
function repoOf(ref) {
  if (typeof ref !== 'string') return null;
  const m = ref.match(/^([A-Za-z][\w-]*):\/\//);
  if (m) return m[1];
  if (ref.startsWith('conv:')) return 'conv';
  return null;
}

function idSuffix(id) {
  const m = /-(\d+)$/.exec(id || '');
  return m ? parseInt(m[1], 10) : 0;
}

function parseLink(s) {
  const i = s.indexOf(':');
  if (i === -1) return { rel: 'blocked-on', target: s };
  return { rel: s.slice(0, i), target: s.slice(i + 1) };
}

// ─── Markdown grammar: entries ────────────────────────────────────────────
// Line form:
//   <id> [<status>] <oneliner>  ::refs a,b  ::links rel:uri  ::cause ref  ::tags a,b  ::ts N ::owner id
// Segments are introduced by a literal "  ::" (two spaces). The one-liner may
// not contain "::" (enforced on write), so the split is unambiguous.
// A tips entry may be followed by body lines, each indented exactly four
// spaces; they attach to the preceding entry and round-trip byte-stably.

const BODY_INDENT = '    ';

function serializeEntry(e) {
  let s = `${e.id} [${e.status}] ${e.oneliner}`;
  if (e.refs && e.refs.length) s += `  ::refs ${e.refs.join(',')}`;
  if (e.links && e.links.length) s += `  ::links ${e.links.map((l) => `${l.rel}:${l.target}`).join(',')}`;
  if (e.causal_parent) s += `  ::cause ${e.causal_parent}`;
  if (e.repo) s += `  ::repo ${e.repo}`;
  if (e.tags && e.tags.length) s += `  ::tags ${e.tags.join(',')}`;
  s += `  ::ts ${e.ts}`;
  s += `  ::owner ${e.owner}`;
  if (e.body) {
    for (const line of String(e.body).split('\n')) s += `\n${BODY_INDENT}${line}`;
  }
  return s;
}

function parseEntryLine(line) {
  const segIdx = line.indexOf('  ::');
  const head = segIdx === -1 ? line : line.slice(0, segIdx);
  const segPart = segIdx === -1 ? '' : line.slice(segIdx);
  const m = head.match(/^(\S+)\s+\[([^\]]+)\]\s+(.*)$/);
  if (!m) return null;
  const e = {
    id: m[1], status: m[2], oneliner: m[3].trim(),
    refs: [], links: [], causal_parent: null, repo: null, tags: [], body: null, ts: null, owner: null,
  };
  for (const seg of segPart.split('  ::').map((s) => s.trim()).filter(Boolean)) {
    const sp = seg.indexOf(' ');
    const key = sp === -1 ? seg : seg.slice(0, sp);
    const val = sp === -1 ? '' : seg.slice(sp + 1).trim();
    if (key === 'refs') e.refs = val.split(',').map((x) => x.trim()).filter(Boolean);
    else if (key === 'links') e.links = val.split(',').map((x) => x.trim()).filter(Boolean).map(parseLink);
    else if (key === 'cause') e.causal_parent = val || null;
    else if (key === 'repo') e.repo = val || null;
    else if (key === 'tags') e.tags = val.split(',').map((x) => x.trim()).filter(Boolean);
    else if (key === 'ts') e.ts = Number(val);
    else if (key === 'owner') e.owner = val || null;
  }
  return e;
}

function serializeCategory(cat, projectName, entries) {
  const lines = [`# ${cat} — ${projectName}`, ''];
  for (const e of [...entries].sort((a, b) => idSuffix(a.id) - idSuffix(b.id))) {
    lines.push(serializeEntry(e));
  }
  return lines.join('\n') + '\n';
}

function parseCategory(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    // Body line: exactly four-space indent, attaches to the previous entry.
    if (line.startsWith(BODY_INDENT) && out.length) {
      const prev = out[out.length - 1];
      const bodyLine = line.slice(BODY_INDENT.length);
      prev.body = prev.body == null ? bodyLine : `${prev.body}\n${bodyLine}`;
      continue;
    }
    const e = parseEntryLine(line);
    if (e) out.push(e);
  }
  return out;
}

// ─── Markdown grammar: roadmap outline ──────────────────────────────────────
// Depth from leading-space count / 2. Marker style is a pure function of depth
// (A. / 1. / (i) / a., cycling), re-derived from sibling index on serialize so
// the file renumbers deterministically and round-trips.

function roadmapMarker(depth, idx) {
  const style = depth % 4;
  if (style === 0) return `${String.fromCharCode(65 + (idx % 26))}.`;         // A.
  if (style === 1) return `${idx + 1}.`;                                       // 1.
  if (style === 2) return `(${toRoman(idx + 1)})`;                             // (i)
  return `${String.fromCharCode(97 + (idx % 26))}.`;                           // a.
}

function toRoman(n) {
  const map = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let r = '';
  for (const [v, s] of map) while (n >= v) { r += s; n -= v; }
  return r;
}

function serializeRoadmap(projectName, tree) {
  const lines = [`# roadmap — ${projectName}`, ''];
  const walk = (nodes, depth) => {
    nodes.forEach((node, i) => {
      let s = `${'  '.repeat(depth)}${roadmapMarker(depth, i)} ${node.text}`;
      if (node.repo) s += `  ::repo ${node.repo}`;
      if (node.refs && node.refs.length) s += `  ::refs ${node.refs.join(',')}`;
      if (node.cause) s += `  ::cause ${node.cause}`;
      lines.push(s);
      if (node.children && node.children.length) walk(node.children, depth + 1);
    });
  };
  walk(tree || [], 0);
  return lines.join('\n') + '\n';
}

function parseRoadmap(text) {
  const root = [];
  const stack = [{ depth: -1, children: root }];
  for (const raw of (text || '').split('\n')) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const depth = Math.floor(indent / 2);
    const body = raw.trim();
    const sp = body.indexOf(' ');
    const rest = sp === -1 ? '' : body.slice(sp + 1); // drop the marker token
    const node = { text: '', repo: null, refs: [], cause: null, children: [] };
    const segIdx = rest.indexOf('  ::');
    node.text = (segIdx === -1 ? rest : rest.slice(0, segIdx)).trim();
    const segPart = segIdx === -1 ? '' : rest.slice(segIdx);
    for (const seg of segPart.split('  ::').map((s) => s.trim()).filter(Boolean)) {
      const k = seg.slice(0, seg.indexOf(' ') === -1 ? seg.length : seg.indexOf(' '));
      const v = seg.slice(k.length).trim();
      if (k === 'repo') node.repo = v || null;
      else if (k === 'refs') node.refs = v.split(',').map((x) => x.trim()).filter(Boolean);
      else if (k === 'cause') node.cause = v || null;
    }
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push({ depth, children: node.children });
  }
  return root;
}

// ─── Store ──────────────────────────────────────────────────────────────────

class DashboardStore {
  /** @param {object} [opts] - { root } override (tests); defaults to ~/.bukowski/dashboard */
  constructor(opts = {}) {
    this.root = opts.root || path.join(os.homedir(), '.bukowski', 'dashboard');
    this.curator = opts.curator || process.env.BUKOWSKI_DASHBOARD_CURATOR_ID || DEFAULT_CURATOR;
    this.projects = new Map(); // id -> Project
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this._loadAll();
  }

  // ── loading / persistence ──────────────────────────────────────────────

  _loadAll() {
    let dirs = [];
    try {
      dirs = fs.readdirSync(this.root, { withFileTypes: true })
        .filter((d) => d.isDirectory()).map((d) => d.name);
    } catch { /* fresh */ }
    for (const id of dirs) {
      try { this._loadProject(id); } catch { /* skip malformed */ }
    }
  }

  _projDir(id) { return path.join(this.root, id); }

  _loadProject(id) {
    const dir = this._projDir(id);
    const meta = this._parseMeta(fs.readFileSync(path.join(dir, 'meta.md'), 'utf-8'));
    const project = {
      id,
      name: meta.name || id,
      goal: meta.goal || '',
      participants: meta.participants || [],
      grants: meta.grants || [],
      repos: meta.repos || [],
      curator: meta.curator || this.curator,
      categories: {},
      roadmap: [],
      rev: meta.rev || 0,
      election: null,
    };
    const ef = path.join(dir, '_election.json');
    if (fs.existsSync(ef)) {
      try { project.election = JSON.parse(fs.readFileSync(ef, 'utf-8')); } catch { /* ignore */ }
    }
    for (const cat of CATEGORIES) {
      const f = path.join(dir, `${cat}.md`);
      project.categories[cat] = fs.existsSync(f) ? parseCategory(fs.readFileSync(f, 'utf-8')) : [];
    }
    const rf = path.join(dir, 'roadmap.md');
    if (fs.existsSync(rf)) project.roadmap = parseRoadmap(fs.readFileSync(rf, 'utf-8'));
    // Recompute the effective participant set from its two persisted sources
    // (repo-derived owners ∪ direct grants); the persisted participants line is
    // a render cache, the union is authoritative and survives a remap.
    this._recomputeParticipants(project);
    this.projects.set(id, project);
    return project;
  }

  _parseMeta(text) {
    const meta = {};
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('# ')) { meta.name = line.slice(2).trim(); continue; }
      const i = line.indexOf(':');
      if (i === -1) continue;
      const key = line.slice(0, i).trim();
      const val = line.slice(i + 1).trim();
      if (key === 'goal') meta.goal = val;
      else if (key === 'curator') meta.curator = val;
      else if (key === 'rev') meta.rev = Number(val) || 0;
      else if (key === 'participants') meta.participants = val.split(',').map((s) => s.trim()).filter(Boolean);
      else if (key === 'grants') meta.grants = val.split(',').map((s) => s.trim()).filter(Boolean);
      else if (key === 'repos') {
        meta.repos = val.split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
          const eq = pair.indexOf('=');
          const repo = eq === -1 ? pair : pair.slice(0, eq).trim();
          const rootPath = eq === -1 ? '' : pair.slice(eq + 1).trim();
          return { repo, root: rootPath, owner: `claude-${hostFromCwd(rootPath)}-1` };
        });
      }
    }
    return meta;
  }

  _serializeMeta(p) {
    const repos = p.repos.map((r) => `${r.repo}=${r.root}`).join(', ');
    return [
      `# ${p.name}`, '',
      `goal: ${p.goal}`,
      `participants: ${p.participants.join(', ')}`,
      `grants: ${(p.grants || []).join(', ')}`,
      `repos: ${repos}`,
      `curator: ${p.curator}`,
      `rev: ${p.rev}`, '',
    ].join('\n');
  }

  _persistProject(p) {
    const dir = this._projDir(p.id);
    fs.mkdirSync(path.join(dir, '_audit'), { recursive: true, mode: 0o700 });
    atomicWrite(path.join(dir, 'meta.md'), this._serializeMeta(p));
    for (const cat of CATEGORIES) {
      atomicWrite(path.join(dir, `${cat}.md`), serializeCategory(cat, p.name, p.categories[cat] || []));
    }
    atomicWrite(path.join(dir, 'roadmap.md'), serializeRoadmap(p.name, p.roadmap));
    const ef = path.join(dir, '_election.json');
    if (p.election) atomicWrite(ef, JSON.stringify(p.election, null, 2));
    else if (fs.existsSync(ef)) { try { fs.unlinkSync(ef); } catch { /* ignore */ } }
    this._persistIndex();
  }

  _persistIndex() {
    const lines = ['# Dashboard Index', '', '## Projects'];
    for (const p of this.projects.values()) lines.push(`- ${p.id}: ${p.goal}`);
    lines.push('', '## Repo Map');
    for (const p of this.projects.values()) {
      for (const r of p.repos) lines.push(`- ${r.repo} -> ${p.id}`);
    }
    lines.push('');
    atomicWrite(path.join(this.root, 'index.md'), lines.join('\n'));
  }

  _appendAudit(p, rec) {
    const day = new Date(rec.ts).toISOString().slice(0, 10);
    const file = path.join(this._projDir(p.id), '_audit', `${day}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o600 });
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  // Re-read one project from disk so an instance sees writes made by a sibling
  // bukowski instance sharing this filesystem (the bench runs N federated
  // instances on one box). Cheap for a tiny bench; disk is the source of truth.
  _refresh(id) {
    if (fs.existsSync(path.join(this._projDir(id), 'meta.md'))) {
      try { this._loadProject(id); } catch { /* keep cached on parse error */ }
    }
  }

  reloadAll() {
    this.projects.clear();
    this._loadAll();
  }

  _project(id) {
    this._refresh(id);
    const p = this.projects.get(id);
    if (!p) throw derr('BAD_PROJECT', `no such project: ${id}`);
    return p;
  }

  // Map a caller to the identity namespace ownership is expressed in. A session
  // agent calling its own bukowski is locally "claude-1", but it owns its repo
  // as the federated "claude-<host>-1" (host = this instance's resolved host).
  // Without this, an agent is rejected from writing its OWN repo's entries.
  // External/federated callers are already host-qualified and pass through.
  _federate(caller) {
    if (!caller || caller === 'user') return caller;
    const m = /^(claude|codex|gemini)-(\d+)$/.exec(caller);
    if (!m) return caller; // already has a host segment (external/federated)
    const host = process.env.BUKOWSKI_HOST || hostFromCwd(process.cwd());
    return `${m[1]}-${host}-${m[2]}`;
  }

  /** Public: map a local caller id to its federated form (for change-feed attribution). */
  federate(caller) { return this._federate(caller); }

  deleteProject(caller, args, ctx = {}) {
    caller = this._federate(caller);
    const p = this._project(args.projectId);
    if (caller !== p.curator && caller !== this.curator && caller !== 'user') {
      throw derr('NOT_CURATOR', `only the curator (${p.curator}), the framework curator, or the user may delete a project`, { caller });
    }
    this.projects.delete(p.id);
    try { fs.rmSync(this._projDir(p.id), { recursive: true, force: true }); } catch { /* ignore */ }
    this._persistIndex();
    return { ok: true, op: 'delete-project', projectId: p.id };
  }

  _ownerForRepo(p, repo) {
    const r = p.repos.find((x) => x.repo === repo);
    if (!r) throw derr('BAD_CATEGORY', `repo not in project: ${repo}`, { kind: 'repo' });
    return r.owner;
  }

  // The "residency" of a federated id is its host segment — the middle piece of
  // claude-<host>-<n> (host may itself contain hyphens, e.g. azra-agent). This
  // is the SAME source on both sides of an edit check: an entry's owner is
  // minted as claude-<hostFromCwd(repoRoot)>-1, and a caller arrives federated
  // to <type>-<host>-<n>. We deliberately key off the id segment, never the
  // transport "host" field (machine hostname) reported by list_agents — that
  // field is asymmetric (owner derivation never uses it) and can diverge from
  // the id segment (an agent whose cwd basename differs from its machine host
  // carries a different residency than its box-mates, and stays scoped to it).
  _hostOf(id) {
    const m = /^(?:claude|codex|gemini)-(.+)-\d+$/.exec(id || '');
    return m ? m[1] : null;
  }

  // Repo-residency multi-edit: any agent resident on the same host as an entry's
  // owner may curate that entry (set/close/promote/link), so {claude,codex}-
  // <host>-{1,2,...} collectively own their box's entries instead of a single
  // named seat. Exact-id still passes (covers ids that don't parse). A null host
  // never matches — unparseable ids fall back to strict owner equality, so this
  // can only widen access among well-formed same-host ids, never beyond them.
  _sameResidency(caller, owner) {
    if (caller === owner) return true;
    const hc = this._hostOf(caller);
    return hc !== null && hc === this._hostOf(owner);
  }

  // Participants come from two sources kept SEPARATELY: the repo-owner set
  // derived from the repo map, and direct curator grants. They must not share
  // storage — map_repos re-derives the whole repo set, so a grant living in the
  // same list would be clobbered on every remap. Effective set is the union,
  // recomputed whenever either source changes (create / map_repos / add /
  // remove / load). Grants exist because root→host→agent derivation can't
  // distinguish co-tenant agents sharing one checkout (codex- and claude-
  // <host>-1 derive to the same owner), so a curator names them directly.
  _deriveParticipants(p) {
    return p.repos.map((r) => r.owner).filter((o) => !ROADMAP_EXCLUDED.has(o));
  }

  _recomputeParticipants(p) {
    const set = new Set(this._deriveParticipants(p));
    for (const g of (p.grants || [])) set.add(g);
    p.participants = [...set];
  }

  addParticipant(caller, args, ctx = {}) {
    caller = this._federate(caller);
    const p = this._project(args.projectId);
    this._requireCurator(caller, p);
    const agentId = this._federate(String(args.agentId || '').trim());
    if (!agentId) throw derr('BAD_KEY', 'agentId required');
    if (!p.grants) p.grants = [];
    const already = p.participants.includes(agentId);
    if (!p.grants.includes(agentId)) p.grants.push(agentId);
    this._recomputeParticipants(p);
    this._mutate(p, { ts: ctx.ts || Date.now(), actor: caller, op: 'add-participant', after: agentId }, ctx);
    return { ok: true, op: 'add-participant', projectId: p.id, agentId, alreadyParticipant: already, rev: p.rev };
  }

  removeParticipant(caller, args, ctx = {}) {
    caller = this._federate(caller);
    const p = this._project(args.projectId);
    this._requireCurator(caller, p);
    const agentId = this._federate(String(args.agentId || '').trim());
    if (!agentId) throw derr('BAD_KEY', 'agentId required');
    if (!p.grants) p.grants = [];
    p.grants = p.grants.filter((g) => g !== agentId);
    this._recomputeParticipants(p);
    // remove revokes the DIRECT grant only; a repo-owner-derived participant
    // stays (drop it via map_repos, not here). Surface which case happened.
    const stillDerived = this._deriveParticipants(p).includes(agentId);
    this._mutate(p, { ts: ctx.ts || Date.now(), actor: caller, op: 'remove-participant', after: agentId }, ctx);
    return { ok: true, op: 'remove-participant', projectId: p.id, agentId, stillParticipantViaRepo: stillDerived, rev: p.rev };
  }

  _requireCurator(caller, p) {
    if (caller !== p.curator && caller !== 'user') {
      throw derr('NOT_CURATOR', `only the curator (${p.curator}) may do this`, { caller });
    }
  }

  _findEntry(p, entryId) {
    for (const cat of CATEGORIES) {
      const e = (p.categories[cat] || []).find((x) => x.id === entryId);
      if (e) return { entry: e, category: cat };
    }
    throw derr('NO_ENTRY', `no such entry: ${entryId}`);
  }

  // Highest id suffix ever ISSUED per (projectId, prefix), kept in a global
  // file OUTSIDE the project dirs so it survives delete-project (the whole
  // point: a recreated project must not mint a second "todo-4" colliding with
  // ids referenced in transcripts/memory from the deleted era). Also covers
  // promote: an id vacated by re-filing is never re-issued in its old category.
  _idseqPath() { return path.join(this.root, '_idseq.json'); }

  _readIdseq() {
    try { return JSON.parse(fs.readFileSync(this._idseqPath(), 'utf-8')); } catch { return {}; }
  }

  _nextId(p, category) {
    const prefix = CATEGORY_PREFIX[category];
    let max = 0;
    for (const e of p.categories[category] || []) max = Math.max(max, idSuffix(e.id));
    const seq = this._readIdseq(); // fresh read: sibling instances share the file
    max = Math.max(max, (seq[p.id] || {})[prefix] || 0);
    const n = max + 1;
    seq[p.id] = seq[p.id] || {};
    seq[p.id][prefix] = n;
    atomicWrite(this._idseqPath(), JSON.stringify(seq, null, 2));
    return `${prefix}-${n}`;
  }

  _mutate(p, rec, ctx) {
    p.rev += 1;
    this._persistProject(p);
    this._appendAudit(p, {
      ts: rec.ts,
      actor: rec.actor,
      conv: ctx.conv || null,
      msg_id: ctx.msgId || null,
      op: rec.op,
      project: p.id,
      category: rec.category || null,
      entry_id: rec.entry_id || null,
      before: rec.before ?? null,
      after: rec.after ?? null,
      causal_parent: rec.causal_parent || null,
    });
  }

  // ── curator-only operations ───────────────────────────────────────────────

  createProject(caller, args, ctx = {}) {
    caller = this._federate(caller);
    // Any agent may create a project; the CREATOR becomes its curator by
    // default (override via args.curator). "If I tell an agent to create a
    // project, they're the curator." They can transfer the lead later.
    const name = String(args.name || '').trim();
    if (!name) throw derr('BAD_PROJECT', 'name required');
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!id) throw derr('BAD_PROJECT', 'name produces an empty slug');
    this._refresh(id); // detect a project a sibling instance already created
    if (this.projects.has(id)) throw derr('BAD_PROJECT', `project already exists: ${id}`);
    const repos = (args.repos || []).map((r) => {
      const repo = typeof r === 'string' ? r : r.repo;
      const root = typeof r === 'string' ? '' : (r.root || '');
      return { repo, root, owner: `claude-${hostFromCwd(root)}-1` };
    });
    // Per-project curator (the lead who owns this project's goal/roadmap/repo
    // map) is distinct from the dashboard-framework curator (this.curator, who
    // owns the category set + bootstraps creation). Defaults to the lead named
    // in args.curator, else the framework curator. Repo owners still own their
    // own entries regardless of who leads the project.
    const projectCurator = args.curator ? this._federate(args.curator) : caller;
    const p = {
      id, name, goal: String(args.goal || ''), participants: [],
      grants: [], repos, curator: projectCurator, categories: {}, roadmap: [], rev: 0, election: null,
    };
    for (const cat of CATEGORIES) p.categories[cat] = [];
    this._recomputeParticipants(p);
    this.projects.set(id, p);
    const ts = ctx.ts || Date.now();
    this._mutate(p, { ts, actor: caller, op: 'create-project', after: name }, ctx);
    return { ok: true, op: 'create-project', projectId: id, rev: p.rev };
  }

  setGoal(caller, args, ctx = {}) {
    caller = this._federate(caller);
    const p = this._project(args.projectId);
    this._requireCurator(caller, p);
    const before = p.goal;
    p.goal = String(args.goal || '');
    this._mutate(p, { ts: ctx.ts || Date.now(), actor: caller, op: 'set-goal', before, after: p.goal }, ctx);
    return { ok: true, op: 'set-goal', projectId: p.id, rev: p.rev };
  }

  mapRepos(caller, args, ctx = {}) {
    caller = this._federate(caller);
    const p = this._project(args.projectId);
    this._requireCurator(caller, p);
    p.repos = (args.repos || []).map((r) => {
      const repo = typeof r === 'string' ? r : r.repo;
      const root = typeof r === 'string' ? '' : (r.root || '');
      return { repo, root, owner: `claude-${hostFromCwd(root)}-1` };
    });
    // Re-derive from the new repo map, then UNION back the direct grants so a
    // remap never silently drops a curator-granted co-tenant participant.
    this._recomputeParticipants(p);
    this._mutate(p, { ts: ctx.ts || Date.now(), actor: caller, op: 'map-repos', after: p.repos.map((r) => r.repo).join(',') }, ctx);
    return { ok: true, op: 'map-repos', projectId: p.id, rev: p.rev };
  }

  setRoadmap(caller, args, ctx = {}) {
    caller = this._federate(caller);
    const p = this._project(args.projectId);
    this._requireCurator(caller, p);
    // Accept three forms: a roadmap tree (array of nodes), a JSON string of
    // that array (MCP transports often stringify array args when the schema
    // doesn't pin type:array — without this branch the JSON leaked into the
    // first node's text), or a multi-line outline string (A. / 1. / (i)).
    let rm = args.roadmap;
    if (typeof rm === 'string') {
      const s = rm.trim();
      if (s.startsWith('[')) { try { rm = JSON.parse(s); } catch { /* fall through */ } }
      if (typeof rm === 'string') rm = parseRoadmap(rm);
    }
    p.roadmap = Array.isArray(rm) ? rm : [];
    this._mutate(p, { ts: ctx.ts || Date.now(), actor: caller, op: 'set-roadmap' }, ctx);
    return { ok: true, op: 'set-roadmap', projectId: p.id, rev: p.rev };
  }

  // ── owner-scoped entry operations ─────────────────────────────────────────

  setEntry(caller, args, ctx = {}) {
    caller = this._federate(caller);
    const p = this._project(args.projectId);
    const oneliner = String(args.oneliner || '').trim();
    if (oneliner.length > MAX_ONELINER) {
      throw derr('ONELINER_TOO_LONG', `one-liner must be <= ${MAX_ONELINER} chars (got ${oneliner.length})`);
    }
    if (oneliner.includes('::')) throw derr('ONELINER_TOO_LONG', 'one-liner may not contain "::"');
    const refs = (args.refs || []).map(String).filter(Boolean);
    // Optional claim state: 'in_progress' (alias 'claimed') signals "I'm doing
    // this" so parallel agents on a shared work-list can see who's mid-flight.
    const stateArg = args.state === 'claimed' ? 'in_progress' : args.state;
    if (stateArg && !['open', 'in_progress'].includes(stateArg)) {
      throw derr('BAD_CATEGORY', `invalid state '${stateArg}' (open|in_progress|claimed)`, { kind: 'state' });
    }

    let category = args.category;
    let entry;
    if (args.entryId) {
      const found = this._findEntry(p, args.entryId);
      entry = found.entry; category = found.category;
    } else {
      if (!CATEGORIES.includes(category)) throw derr('BAD_CATEGORY', `unknown category: ${category}`);
    }
    if (ACTIONABLE.has(category) && refs.length === 0) {
      throw derr('MISSING_REFS', `category '${category}' requires >=1 grounding ref (sha/file/conv/uri)`);
    }
    // Body: only `tips` carries one (wikihow summary; the ref'd doc stays
    // canonical). Normalized to single newlines so the four-space body-line
    // grammar round-trips; capped to keep tips.md greppable.
    let body = args.body == null ? undefined : String(args.body).replace(/\r/g, '').replace(/\n{2,}/g, '\n').trim();
    if (body !== undefined && category !== 'tips') {
      throw derr('BODY_NOT_ALLOWED', `category '${category}' is pointers-only; body is allowed only for tips`);
    }
    if (body !== undefined && body.length > MAX_TIP_BODY) {
      throw derr('BODY_TOO_LONG', `tip body must be <= ${MAX_TIP_BODY} chars (got ${body.length}); link the doc and summarize`);
    }
    const tags = args.tags == null ? undefined
      : (Array.isArray(args.tags) ? args.tags : String(args.tags).split(','))
        .map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    const owner = this._ownerForRepo(p, args.repo);
    if (!this._sameResidency(caller, owner) && caller !== 'user') {
      throw derr('NOT_RESPONSIBLE', `only agents resident on ${owner}'s host (owner of ${args.repo}) may write this entry; FIPA them a request instead`, { caller, owner });
    }
    if (entry && args.ifRev != null && Number(args.ifRev) !== p.rev) {
      throw derr('CONFLICT', `stale write: ifRev=${args.ifRev} but project rev=${p.rev}`);
    }
    const ts = ctx.ts || Date.now();
    const before = entry ? entry.oneliner : null;
    if (entry) {
      // LWW on body: only apply if this write is newer than the stored one.
      if (ts >= (entry.ts || 0)) {
        entry.oneliner = oneliner;
        entry.refs = refs.length ? refs : entry.refs;
        if (args.causal_parent !== undefined) entry.causal_parent = args.causal_parent || null;
        if (stateArg) entry.status = stateArg;
        if (body !== undefined) entry.body = body || null;
        if (tags !== undefined) entry.tags = tags;
        entry.ts = ts;
      }
    } else {
      entry = {
        id: this._nextId(p, category), oneliner, refs,
        links: [], owner, status: stateArg || 'open', repo: args.repo,
        causal_parent: args.causal_parent || null,
        tags: tags || [], body: body || null, ts,
      };
      p.categories[category].push(entry);
    }
    this._mutate(p, { ts, actor: caller, op: args.entryId ? 'update' : 'create', category, entry_id: entry.id, before, after: oneliner, causal_parent: entry.causal_parent }, ctx);
    const res = { ok: true, op: args.entryId ? 'update' : 'create', projectId: p.id, entryId: entry.id, rev: p.rev };
    // Collision visibility (not locking): when claiming, surface other
    // in-progress entries in this category owned by someone else, so the
    // claimer notices duplicate parallel work before opening a redundant PR.
    if (entry.status === 'in_progress') {
      const others = (p.categories[category] || [])
        .filter((x) => x.id !== entry.id && x.status === 'in_progress' && x.owner !== owner)
        .map((x) => ({ id: x.id, owner: x.owner, oneliner: x.oneliner }));
      if (others.length) res.inProgressElsewhere = others;
    }
    const refWarnings = this._refRepoWarnings(p, refs);
    if (refWarnings.length) res.warnings = refWarnings;
    return res;
  }

  /** Soft prefix-check: a "<repo>://..." ref whose <repo> isn't in the project map. Pure. */
  _refRepoWarnings(p, refs) {
    const repoNames = new Set(p.repos.map((r) => r.repo));
    const warns = [];
    for (const ref of refs || []) {
      const m = /^([A-Za-z][\w-]*):\/\//.exec(String(ref));
      if (m && !repoNames.has(m[1])) {
        warns.push(`ref "${ref}": "${m[1]}" is not a repo in this project (known: ${[...repoNames].join(', ') || 'none'})`);
      }
    }
    return warns;
  }

  /** Repo→checkout-root map for a project (used by the MCP layer's sha existence check). */
  repoRoots(id) {
    const p = this._project(id);
    return p.repos.map((r) => ({ repo: r.repo, root: r.root }));
  }

  closeEntry(caller, args, ctx = {}) {
    caller = this._federate(caller);
    const p = this._project(args.projectId);
    const { entry, category } = this._findEntry(p, args.entryId);
    if (!this._sameResidency(caller, entry.owner) && caller !== 'user') {
      throw derr('NOT_RESPONSIBLE', `only agents resident on ${entry.owner}'s host or the user may close ${entry.id}`, { caller });
    }
    const before = entry.status;
    entry.status = args.status === 'wontfix' ? 'wontfix' : 'closed';
    const ts = ctx.ts || Date.now();
    entry.ts = ts;
    this._mutate(p, { ts, actor: caller, op: 'close', category, entry_id: entry.id, before, after: entry.status }, ctx);
    return { ok: true, op: 'close', projectId: p.id, entryId: entry.id, rev: p.rev };
  }

  commentEntry(caller, args, ctx = {}) {
    caller = this._federate(caller);
    const p = this._project(args.projectId);
    const { entry, category } = this._findEntry(p, args.entryId);
    const isParticipant = p.participants.includes(caller) || caller === p.curator || caller === 'user';
    if (!isParticipant) throw derr('NOT_RESPONSIBLE', `only project participants may comment`, { caller });
    const text = String(args.text || '').trim();
    if (!text) throw derr('BAD_KEY', 'comment text required');
    // Comments are audit-only (append-only); they never mutate the entry body,
    // so they live purely in the audit log, keeping the entry a clean pointer.
    const ts = ctx.ts || Date.now();
    this._mutate(p, { ts, actor: caller, op: 'comment', category, entry_id: entry.id, after: text }, ctx);
    return { ok: true, op: 'comment', projectId: p.id, entryId: entry.id, rev: p.rev };
  }

  promoteEntry(caller, args, ctx = {}) {
    caller = this._federate(caller);
    const p = this._project(args.projectId);
    const { entry, category } = this._findEntry(p, args.entryId);
    if (!this._sameResidency(caller, entry.owner) && caller !== 'user') {
      throw derr('NOT_RESPONSIBLE', `only agents resident on ${entry.owner}'s host may promote ${entry.id}`, { caller });
    }
    const to = args.toCategory;
    if (!CATEGORIES.includes(to)) throw derr('BAD_CATEGORY', `unknown category: ${to}`);
    if (to === category) return { ok: true, op: 'promote', projectId: p.id, entryId: entry.id, rev: p.rev };
    // Re-file in place: same record, new category + new id prefix, body/refs/
    // links/owner travel with it. No duplication; lineage recorded in audit.
    const idx = p.categories[category].indexOf(entry);
    p.categories[category].splice(idx, 1);
    const oldId = entry.id;
    entry.id = this._nextId(p, to);
    const ts = ctx.ts || Date.now();
    entry.ts = ts;
    p.categories[to].push(entry);
    this._mutate(p, { ts, actor: caller, op: 'promote', category: to, entry_id: entry.id, before: `${category}:${oldId}`, after: `${to}:${entry.id}` }, ctx);
    return { ok: true, op: 'promote', projectId: p.id, entryId: entry.id, from: oldId, rev: p.rev };
  }

  linkBlockedOn(caller, args, ctx = {}) {
    caller = this._federate(caller);
    const p = this._project(args.projectId);
    const { entry, category } = this._findEntry(p, args.entryId);
    if (!this._sameResidency(caller, entry.owner) && caller !== 'user') {
      throw derr('NOT_RESPONSIBLE', `only agents resident on ${entry.owner}'s host may link ${entry.id}`, { caller });
    }
    const rel = args.rel || 'blocked-on';
    if (!['blocked-on', 'supersedes', 'caused-by'].includes(rel)) {
      throw derr('BAD_LINK', `invalid rel '${rel}' (blocked-on|supersedes|caused-by)`);
    }
    const targets = (args.targets || args.blockedOn || []).map(String).filter(Boolean);
    if (!targets.length) throw derr('BAD_LINK', 'must list >=1 target ref/entry');
    for (const t of targets) {
      if (!entry.links.some((l) => l.rel === rel && l.target === t)) {
        entry.links.push({ rel, target: t });
      }
    }
    const ts = ctx.ts || Date.now();
    this._mutate(p, { ts, actor: caller, op: 'link', category, entry_id: entry.id, after: `${rel}:${targets.join(',')}` }, ctx);
    return { ok: true, op: 'link', projectId: p.id, entryId: entry.id, rel, rev: p.rev };
  }

  transferCurator(caller, args, ctx = {}) {
    caller = this._federate(caller);
    const p = this._project(args.projectId);
    // Authorized by the current project lead, the always-on framework curator,
    // or the user. The framework-curator/user path is the offline-recovery
    // route: if the project curator is unreachable, bukowski-1 or Vladimir hands
    // the lead to an online agent — no liveness-guessing, no split-brain.
    if (caller !== p.curator && caller !== this.curator && caller !== 'user') {
      throw derr('NOT_CURATOR', `only the project curator (${p.curator}), the framework curator, or the user may transfer the lead`, { caller });
    }
    const to = this._federate(String(args.to || '').trim());
    if (!to) throw derr('BAD_PROJECT', 'transfer target (to) required');
    const before = p.curator;
    p.curator = to;
    this._mutate(p, { ts: ctx.ts || Date.now(), actor: caller, op: 'transfer-curator', before, after: to }, ctx);
    return { ok: true, op: 'transfer-curator', projectId: p.id, curator: to, rev: p.rev };
  }

  // ── curator election (self-heal when the curator is offline) ──────────────
  // The election state lives on the shared project (disk), so once opened every
  // instance sees the same votes; the tiebreak is seeded by the stable election
  // id (NOT Math.random) so all instances converge on the same winner.

  _hashInt(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  }

  _tallyElection(p) {
    const counts = {};
    for (const v of Object.values(p.election.votes)) counts[v] = (counts[v] || 0) + 1;
    const max = Math.max(0, ...Object.values(counts));
    const top = Object.keys(counts).filter((k) => counts[k] === max).sort();
    let winner;
    if (top.length === 0) winner = p.election.candidates.slice().sort()[0];
    else if (top.length === 1) winner = top[0];
    else winner = top[this._hashInt(p.election.id) % top.length]; // deterministic random tiebreak
    p.curator = winner;
    p.election = null;
    return winner;
  }

  /** Read-only meta the MCP layer uses to compute liveness before an election. */
  meta(id) {
    const p = this._project(id);
    return { id: p.id, curator: p.curator, participants: p.participants.slice(), election: p.election ? { ...p.election } : null };
  }

  openElection(caller, args, ctx = {}, opts = {}) {
    caller = this._federate(caller);
    const p = this._project(args.projectId);
    if (!p.participants.includes(caller) && caller !== 'user') {
      throw derr('NOT_RESPONSIBLE', 'only a project participant may open an election', { caller });
    }
    if (p.election) {
      throw derr('ELECTION_OPEN', `an election (${p.election.id}) is already open — vote or close it first`);
    }
    if (opts.curatorOnline) {
      throw derr('CURATOR_ONLINE', `curator ${p.curator} is reachable — transfer the lead instead of electing`);
    }
    const pool = (opts.onlineParticipants && opts.onlineParticipants.length) ? opts.onlineParticipants : p.participants;
    const candidates = pool.filter((a) => a !== p.curator);
    if (!candidates.length) throw derr('BAD_PROJECT', 'no eligible online candidates for election');
    const ts = ctx.ts || Date.now();
    p.election = { id: `${p.id}-${p.rev + 1}`, openedBy: caller, openedAt: ts, candidates, votes: {} };
    this._mutate(p, { ts, actor: caller, op: 'open-election', after: candidates.join(',') }, ctx);
    return { ok: true, op: 'open-election', projectId: p.id, electionId: p.election.id, candidates, rev: p.rev };
  }

  vote(caller, args, ctx = {}) {
    caller = this._federate(caller);
    const p = this._project(args.projectId);
    if (!p.election) throw derr('NO_ELECTION', 'no open election for this project');
    if (!p.election.candidates.includes(caller) && caller !== 'user') {
      throw derr('NOT_RESPONSIBLE', 'only an online candidate may vote', { caller, candidates: p.election.candidates });
    }
    const candidate = this._federate(String(args.candidate || '').trim());
    if (!p.election.candidates.includes(candidate)) throw derr('BAD_LINK', `candidate not on the slate: ${candidate}`);
    p.election.votes[caller] = candidate;
    const ts = ctx.ts || Date.now();
    // Auto-tally once every candidate has voted (no timer needed for the bench).
    let elected = null;
    if (p.election.candidates.every((c) => p.election.votes[c] !== undefined)) elected = this._tallyElection(p);
    this._mutate(p, { ts, actor: caller, op: elected ? 'elect-curator' : 'vote', after: elected ? elected : `${caller}->${candidate}` }, ctx);
    return { ok: true, op: 'vote', projectId: p.id, voted: candidate, tallied: !!elected, curator: elected || undefined, rev: p.rev };
  }

  closeElection(caller, args, ctx = {}) {
    caller = this._federate(caller);
    const p = this._project(args.projectId);
    if (!p.election) throw derr('NO_ELECTION', 'no open election for this project');
    if (!p.participants.includes(caller) && caller !== 'user') {
      throw derr('NOT_RESPONSIBLE', 'only a project participant may close an election', { caller });
    }
    const ts = ctx.ts || Date.now();
    const winner = this._tallyElection(p); // tally whatever votes are in (offline candidates skipped)
    this._mutate(p, { ts, actor: caller, op: 'elect-curator', after: winner }, ctx);
    return { ok: true, op: 'elect-curator', projectId: p.id, curator: winner, rev: p.rev };
  }

  // ── reads (no auth, no mutation) ──────────────────────────────────────────

  /**
   * Who should be notified of a change, scoped for signal/noise.
   *   - project-level ops (goal/roadmap/repos/curator/election/delete) → all participants
   *   - entry-level ops → STAKEHOLDERS only: the entry's owner + owners of entries
   *     cross-linked in either direction (entries this one links to, and entries
   *     that link to it). A self-edit to an unlinked entry reaches nobody else.
   * The mutator (info.by) and 'user' are always excluded. Federated ids.
   */
  recipientsFor(projectId, info = {}) {
    const p = this.projects.get(projectId);
    if (!p) return [];
    const PROJECT_OPS = new Set(['create-project', 'set-goal', 'map-repos', 'set-roadmap',
      'add-participant', 'remove-participant',
      'transfer-curator', 'open-election', 'vote', 'elect-curator', 'delete-project']);
    const recip = new Set();
    const allEntries = [];
    for (const cat of CATEGORIES) for (const e of p.categories[cat] || []) allEntries.push(e);
    const tokensOf = (e) => [e.id, `${e.repo || (p.repos[0] || {}).repo || p.id}://entry/${e.id}`];

    if (!info.entryId || PROJECT_OPS.has(info.op)) {
      for (const a of p.participants) recip.add(a);
    } else {
      const X = allEntries.find((e) => e.id === info.entryId);
      if (!X) {
        for (const a of p.participants) recip.add(a); // entry gone → fall back
      } else {
        const xTokens = new Set([...tokensOf(X), ...(X.refs || [])]);
        const ownerByToken = new Map();
        for (const e of allEntries) for (const tok of tokensOf(e)) ownerByToken.set(tok, e.owner);
        if (X.owner) recip.add(X.owner);
        // forward: only on the link op itself — tell the target owner "someone
        // now links to yours" (not on every later edit, which would re-noise).
        if (info.op === 'link') {
          for (const l of X.links || []) { const o = ownerByToken.get(l.target); if (o) recip.add(o); }
        }
        // reverse: owners of entries that depend on X care whenever X changes.
        for (const e of allEntries) {
          if ((e.links || []).some((l) => xTokens.has(l.target)) && e.owner) recip.add(e.owner);
        }
      }
    }
    recip.delete(this._federate(info.by));
    recip.delete('user');
    return [...recip].filter(Boolean);
  }

  listProjects() {
    this.reloadAll();
    return {
      ok: true,
      projects: Array.from(this.projects.values()).map((p) => ({
        id: p.id, goal: p.goal, curator: p.curator, repos: p.repos.map((r) => r.repo),
        participants: p.participants, rev: p.rev, election: p.election ? p.election.id : null,
      })),
    };
  }

  queryEntries(caller, args) {
    const p = this._project(args.projectId);
    // Targeted get: {entryId} returns the single entry IN FULL (this is the
    // read path for a tip's body). List results below omit bodies — they're
    // the cheap index (id + one-liner + tags); fetch by id for the summary.
    if (args.entryId) {
      const { entry, category } = this._findEntry(p, args.entryId);
      return { ok: true, projectId: p.id, rev: p.rev, entries: [{ ...entry, category }] };
    }
    const cats = args.category ? [args.category] : CATEGORIES;
    if (args.repo) this._ownerForRepo(p, args.repo); // validates repo exists
    const tag = args.tag ? String(args.tag).trim().toLowerCase() : null;
    const q = args.q ? String(args.q).trim().toLowerCase() : null;
    const out = [];
    for (const cat of cats) {
      for (const e of p.categories[cat] || []) {
        if (args.repo && e.repo !== args.repo) continue;
        if (args.state && e.status !== args.state) continue;
        if (args.blockedOnly && !(e.links || []).some((l) => l.rel === 'blocked-on')) continue;
        if (tag && !(e.tags || []).includes(tag)) continue;
        // Keyword: matches one-liner, tags, or body (bodies searchable, never returned in lists).
        if (q && !(`${e.oneliner} ${(e.tags || []).join(' ')} ${e.body || ''}`.toLowerCase().includes(q))) continue;
        const { body, ...rest } = e;
        if (body) rest.hasBody = true; // fetch by entryId for the full body
        out.push({ ...rest, category: cat });
      }
    }
    return { ok: true, projectId: p.id, rev: p.rev, entries: out };
  }

  digest(caller, args) {
    const p = this._project(args.projectId);
    const sinceRev = Number(args.sinceRev || 0);
    const cats = args.categories && args.categories.length ? args.categories : CATEGORIES;
    const lines = [`# ${p.name} · ${p.goal} · rev ${p.rev}`];
    if (p.roadmap.length) {
      lines.push('', '## roadmap', serializeRoadmap(p.name, p.roadmap).split('\n').slice(2).join('\n').trimEnd());
    }
    for (const cat of cats) {
      const entries = (p.categories[cat] || []).filter((e) => !sinceRev || (e.ts || 0) > sinceRev);
      if (!entries.length) continue;
      lines.push('', `## ${cat}`);
      for (const e of entries) {
        const refs = e.refs && e.refs.length ? `  — ${e.refs.join(', ')}` : '';
        const blocked = (e.links || []).filter((l) => l.rel === 'blocked-on').map((l) => l.target);
        const blk = blocked.length ? `  blocked-on:[${blocked.join(', ')}]` : '';
        lines.push(`- [${e.status}] ${e.id} ${e.oneliner}${refs}${blk}`);
      }
    }
    return { ok: true, projectId: p.id, rev: p.rev, digest: lines.join('\n') };
  }

  /**
   * Walk a causal chain from a grounding ref back to its root, using entries'
   * refs + causal_parent ONLY (no copied bodies). Returns root-first.
   */
  walkChain(fromRef) {
    this.reloadAll();
    // index: any ref an entry "produces" (its refs[] or its entry URI) ->
    // { oneliner, parents: [{rel, target}] }. Causal structure is a DAG: an
    // entry can have multiple TYPED parent edges (causal_parent, caused-by,
    // supersedes). blocked-on is a dependency, NOT lineage, so it's excluded.
    const index = new Map();
    for (const p of this.projects.values()) {
      for (const cat of CATEGORIES) {
        for (const e of p.categories[cat] || []) {
          const parents = [];
          if (e.causal_parent) parents.push({ rel: 'causal', target: e.causal_parent });
          for (const l of e.links || []) {
            if (l.rel === 'caused-by' || l.rel === 'supersedes') parents.push({ rel: l.rel, target: l.target });
          }
          const rec = { oneliner: e.oneliner, parents };
          for (const r of e.refs || []) index.set(r, rec);
          index.set(`${e.repo || (p.repos[0] || {}).repo || p.id}://entry/${e.id}`, rec);
        }
      }
    }
    const nodeOf = (ref) => {
      const rec = index.get(ref);
      return { ref, oneliner: rec ? rec.oneliner : null, repo: repoOf(ref), known: !!rec };
    };
    // Full typed-edge DAG traversal: every parent edge is surfaced, so neither
    // caused-by nor supersedes is ever silently dropped.
    const nodes = new Map();
    const edges = [];
    const seen = new Set();
    const queue = [fromRef];
    while (queue.length) {
      const cur = queue.shift();
      if (seen.has(cur)) continue;
      seen.add(cur);
      nodes.set(cur, nodeOf(cur));
      const rec = index.get(cur);
      if (rec) for (const par of rec.parents) {
        edges.push({ from: cur, to: par.target, rel: par.rel });
        if (!seen.has(par.target)) queue.push(par.target);
      }
    }
    // `chain`: convenience linear spine, root-first, following the PRIMARY
    // causal parent with deterministic precedence causal > caused-by >
    // supersedes. Use `edges` for the full DAG including sibling lineages.
    const chain = [];
    const cseen = new Set();
    let cur = fromRef;
    while (cur && !cseen.has(cur)) {
      cseen.add(cur);
      chain.push(nodeOf(cur));
      const rec = index.get(cur);
      const spine = rec && (
        rec.parents.find((pp) => pp.rel === 'causal')
        || rec.parents.find((pp) => pp.rel === 'caused-by')
        || rec.parents.find((pp) => pp.rel === 'supersedes')
      );
      cur = spine ? spine.target : null;
    }
    chain.reverse();
    return { ok: true, fromRef, found: index.has(fromRef), nodes: [...nodes.values()], edges, chain };
  }
}

module.exports = {
  DashboardStore,
  CATEGORIES,
  // exported for unit tests
  _internals: {
    serializeEntry, parseEntryLine, serializeCategory, parseCategory,
    serializeRoadmap, parseRoadmap, repoOf, roadmapMarker,
  },
};
