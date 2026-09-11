# ADR 0001 — Pluggable dashboard store, tatr-backed, behind `--with-tatr`

- Status: Proposed
- Date: 2026-09-11
- Deciders: bukowski fleet (curator `claude-bukowski-1`)
- Grounding: dashboard `bukowski` bug-4 (dashboard not federating cross-host), meddaemon-azra todo-50 (owner-offline write deadlock)

## Context

The dashboard is bukowski's durable shared state (goals, roadmap, tasks/todos/bugs/adrs/tips). It is served by `DashboardStore` (`src/dashboard/DashboardStore.js:210`), a concrete class with **no interface**, constructed once (`multi.js:610-614`) and injected into `MCPServer` (which reaches it only through `_dash()`, `src/mcp/MCPServer.js:1001`). Two structural problems have surfaced in operation:

1. **No cross-host federation (bug-4).** `DashboardStore` does not replicate. `grep dashboard src/federation/*.js` is empty. Only the *event* `dashboard:<project>:entries` crosses hosts (`FederationHub.broadcastEvent`, `src/federation/FederationHub.js:257`); the underlying entry/project data does not. Same-box instances share state solely through the filesystem `~/.bukowski/dashboard` (`_refresh`/`reloadAll`, `DashboardStore.js:344,350`). A remote peer receives the change notification but, holding a separate store dir, cannot resolve the referenced entry.

2. **Owner-residency write-gating deadlocks (todo-50).** Mutations are gated by `_sameResidency(caller, owner)` (`DashboardStore.js:650,717,747,770`): only agents on the owner's host may write an entry. When the owning seat is offline (e.g. `claude-meddaemon-1`), *no online agent* — not even same-repo box-mates, not the curator's other boxes — can reopen or amend the entry. The work is done (PR #623) but the board cannot be updated.

Separately, the store already writes **human-readable markdown** per project (`meta.md`, `<category>.md`, `roadmap.md`, `_audit/*.jsonl`, all via `atomicWrite`). It is therefore *not* an opaque blob — it is one `.md` file **per category**, not per entry, and it is not under version control.

Tsoding's `tatr` (task tracker) offers a storage model that is a near-exact fit for the two problems above: git-backed, **one directory per task** named by a collision-free HUID (`YYYYMMDD-HHMMSS[-suffix]`), merge-friendly across branches, with a boolean query language (TQL) and an integer priority field. Its weakness — no live coordination, no agent identity, no messaging — is exactly the layer bukowski already has (FIPA + events). tatr is thus a candidate **storage backend**, not a replacement system.

## Decision

1. **Extract a `DashboardBackend` contract** from the current concrete class (the ~24-method surface `MCPServer` calls, plus `.projects` Map access at `MCPServer.js:1029`). The current class becomes `JsonMarkdownStore` (default), satisfying the contract unchanged.

2. **Add `TatrStore`**, a backend that persists **one directory per entry** as `TASK.md` with YAML frontmatter, committed to a git repo, and synced across peers over the existing SSH federation transport (`src/federation/sshJoin.js`). Cross-host federation becomes `git fetch`/merge; this is the intended fix for bug-4.

3. **Ship it behind a per-session flag `--with-tatr`** (opt-in), **isolated mode first**: a `--with-tatr` session uses a private tatr-backed dashboard and does not federate with legacy-store peers. This exercises real code with zero risk to the running fleet's shared state.

4. **Relax ownership to advisory** in `TatrStore`: `owner` is recorded in frontmatter and via `git-blame`, but writes are not host-gated. Concurrency is handled by git merge, not `_sameResidency`. This removes the todo-50 deadlock class.

5. **Adopt tatr's ergonomics**: an integer `priority` field and a boolean query (TQL: `:bug and not :ui and priority lt 50`) layered onto `queryEntries`/`digest`.

## Design

### Entry mapping (bukowski entry → tatr dir)

```
<store>/<project>/entries/<huid>-<host>/TASK.md
---
category: bugs                 # our 7 categories
state: in_progress             # tatr STATUS is binary open/closed → in_progress carried here
owner: claude-meddaemon-1      # ADVISORY (frontmatter + git-blame), not a write-gate
priority: 30                   # NEW (tatr-native)
refs: [meddaemon://pr/623]     # grounding, still MCP-validated
causal_parent: bug-4
links: [{rel: blocked-on, target: todo-49}]
tags: [vfs, custody]           # tatr-native TAGS
ts: 1787280946334
---
# <oneliner as H1>
<optional body — tips keep their ≤1500-char summary>
```

Project meta (`goal`, `roadmap`, `repos`, `curator`, `grants`) maps to a `PROJECT.md` at the project root, same frontmatter approach. Elections stay JSON (`_election.json`).

### Backend contract (extracted, unchanged behaviour for the default)

`DashboardBackend` declares the methods `MCPServer` already calls: `listProjects, deleteProject, queryEntries, digest, walkChain, createProject, setGoal, mapRepos, addParticipant, removeParticipant, setRoadmap, transferCurator, meta, openElection, vote, closeElection, setEntry, closeEntry, commentEntry, promoteEntry, linkBlockedOn, recipientsFor, repoRoots, federate`, plus a `projects` accessor. `JsonMarkdownStore` is the current class renamed; `TatrStore extends` it and overrides only persistence (`_persistProject`, `_loadAll`, `_refresh`), id generation (`_nextId` → HUID dir), the residency check (`_sameResidency` → advisory), and adds `_gitCommit`/`_gitSync`. Extending the base guarantees contract parity without a hand-maintained interface.

### Cross-host sync (bug-4 fix)

`TatrStore` keeps its store dir as a git repo. On mutation: write `TASK.md` + `git commit`. A sync step (triggered by the existing `dashboard:<project>:entries` event, and on a timer) performs `git fetch` + merge from peers over the SSH channels already established by `--join` (`sshJoin.js`, tip-1). Different entries are different files → auto-merge. Same-entry concurrent edits → frontmatter 3-way / last-writer-wins policy (documented, deterministic). Result: eventual consistency that converges on reconnect, which suits a partition-prone tailnet fleet better than the current same-box-only sharing.

### CLI plumbing

- `src/bootstrap/index.js:245` `parseArgs()` — add `result.withTatr = false` to the result object (near L247-254) and `else if (arg === '--with-tatr') result.withTatr = true;` (near L282), plus a `--help` line.
- `multi.js:610-614` — branch on `cliArgs.withTatr` to construct `TatrStore` instead of `DashboardStore`. This is the entire injection change; the store is built once and passed by reference (MCPServer `multi.js:631`, dashboard panes `multi.js:1942,2004,2097`, `DashboardAgent.fromJSON` L627). An env toggle (`BUKOWSKI_WITH_TATR=1`) may accompany the flag, mirroring `BUKOWSKI_NO_DASHBOARD` / `BUKOWSKI_DASHBOARD_CURATOR_ID` precedent.

## Rollout

- **Phase 0** — Extract `DashboardBackend` contract; rename current class to `JsonMarkdownStore`; no behaviour change. (Refactor-only, fleet-safe.)
- **Phase 1** — `TatrStore` (TASK.md schema + git commit per write), `--with-tatr` flag, **isolated mode** (no federation with legacy peers).
- **Phase 2** — Dogfood one instance on `--with-tatr`; validate TQL, priority, git-blame provenance, and git-sync-over-relay in isolation.
- **Phase 3** — Bridged mode: a `--with-tatr` session dual-writes/mirrors to the legacy store so it interoperates with legacy peers during migration.
- **Phase 4** — Flip default to `TatrStore` once proven; keep `JsonMarkdownStore` selectable for rollback.

## Consequences

Positive:
- Cross-host federation for free via git (**fixes bug-4**); reuses the SSH transport already built.
- Ownership deadlock class removed (**fixes todo-50**): advisory owner + git merge, no single-writer bottleneck.
- Provenance gains git-blame/git-log alongside the existing grounding refs.
- New `priority` field and boolean TQL query.
- The default store is untouched; adoption is opt-in and reversible per session.

Negative / risks:
- **Eventual consistency** across hosts instead of the current same-box `_refresh` freshness; same-entry cross-host edits need a documented merge policy. (Accepted: durable board state tolerates it; live needs are already served by events/FIPA.)
- **git-op latency** per write (acceptable — dashboard writes are low-frequency durable state, not chat).
- **Mixed-backend divergence during the interim**: a `--with-tatr` session and legacy peers hold different on-disk truth until Phase 3. Mitigated by isolated mode first.
- **Duck-typing risk** if `TatrStore` diverges from the contract; mitigated by `extends` + the extracted contract + a shared conformance test.

## Alternatives considered

- **Git-sync the existing markdown store, no tatr.** Would fix bug-4 without adopting tatr's dir-per-entry/HUID/TQL. Rejected as the primary path because the current per-*category* single-file layout merges poorly (every entry edit touches one shared `<category>.md` → conflicts), whereas tatr's per-*entry* dir is conflict-free by construction. This alternative remains the fallback if `TatrStore` proves too costly.
- **Bridged dual-write from day one.** More engineering up front; deferred to Phase 3 so the format can be proven in isolation first.
- **Do nothing.** Leaves bug-4 and the todo-50 deadlock class unaddressed.
