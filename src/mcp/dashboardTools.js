// src/mcp/dashboardTools.js - MCP tool definitions for the FIPA-native project
// dashboard. Shared verbatim by the server (MCPServer._defineTools) and the
// bridge (static TOOLS, advertised even when bukowski is down) so the two lists
// can never drift. Handlers live in MCPServer._handleToolCall.

const CATEGORY_ENUM = ['description', 'challenges', 'tasks', 'todos', 'nicetohaves', 'bugs', 'adrs', 'tips'];

const repoItem = {
  type: 'object',
  properties: {
    repo: { type: 'string', description: 'logical repo name, e.g. "meddaemon"' },
    root: { type: 'string', description: 'local checkout path (used to derive the owner agent)' },
  },
  required: ['repo'],
};

const DASHBOARD_TOOLS = [
  {
    name: 'dashboard_delete_project',
    description: 'Delete a project and its files. Allowed by the project curator, the framework curator (claude-bukowski-1), or the user. Destructive — drops entries, roadmap, and audit; no tombstone or backup. Last resort: entries that ever crossed an agent\'s context survive as dashboard tool-results in that agent\'s transcript (~/.claude/projects/*/<session>.jsonl) and can be recovered from there.',
    inputSchema: { type: 'object', required: ['projectId'], properties: { projectId: { type: 'string' } } },
  },
  {
    name: 'dashboard_list_projects',
    description: 'List dashboard projects (id, goal, repos, participants, rev).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dashboard_create_project',
    description: 'Create a project spanning multiple repos. The CREATOR becomes the project curator (lead who owns its goal/roadmap) by default; pass curator to set someone else. Participants are derived from each repo\'s owner agent.',
    inputSchema: {
      type: 'object',
      required: ['name', 'goal'],
      properties: {
        name: { type: 'string', description: 'human name; slugified into the project id' },
        goal: { type: 'string', description: 'one-line general goal' },
        repos: { type: 'array', items: repoItem, description: 'repos this project spans' },
        curator: { type: 'string', description: 'project lead agent id (owns goal/roadmap/repo-map); defaults to the framework curator' },
      },
    },
  },
  {
    name: 'dashboard_set_goal',
    description: 'Curator-only. Update a project\'s goal.',
    inputSchema: { type: 'object', required: ['projectId', 'goal'], properties: { projectId: { type: 'string' }, goal: { type: 'string' } } },
  },
  {
    name: 'dashboard_map_repos',
    description: 'Curator-only. Replace a project\'s repo map (and re-derive participants). Direct grants (dashboard_add_participant) are preserved across a remap.',
    inputSchema: { type: 'object', required: ['projectId', 'repos'], properties: { projectId: { type: 'string' }, repos: { type: 'array', items: repoItem } } },
  },
  {
    name: 'dashboard_add_participant',
    description: 'Curator-only. Directly grant an agent participant rights (comment/vote/election) on a project, bypassing repo-owner derivation. For co-tenant agents that share one checkout root and so cannot be distinguished by the repo map (e.g. codex- and claude-<host>-1 on the same root), or cross-host guests with no repo in the project. The grant is stored separately and survives dashboard_map_repos.',
    inputSchema: { type: 'object', required: ['projectId', 'agentId'], properties: { projectId: { type: 'string' }, agentId: { type: 'string', description: 'federated agent id to grant, e.g. codex-azra-agent-1' } } },
  },
  {
    name: 'dashboard_remove_participant',
    description: 'Curator-only. Revoke a DIRECT participant grant (added via dashboard_add_participant). Does not remove a repo-owner-derived participant — change the repo map for that. Response flags stillParticipantViaRepo if the agent remains a participant through derivation.',
    inputSchema: { type: 'object', required: ['projectId', 'agentId'], properties: { projectId: { type: 'string' }, agentId: { type: 'string', description: 'federated agent id whose direct grant to revoke' } } },
  },
  {
    name: 'dashboard_transfer_curator',
    description: 'Reassign a project\'s curator (lead). Allowed by the current project curator, the framework curator (claude-bukowski-1), or the user.',
    inputSchema: { type: 'object', required: ['projectId', 'to'], properties: { projectId: { type: 'string' }, to: { type: 'string', description: 'new curator (lead) agent id' } } },
  },
  {
    name: 'dashboard_open_election',
    description: 'Open a curator election when the current curator is OFFLINE (unreachable in the federation roster) and no authority is around to transfer the lead. Candidates = currently-online participants. Rejected if the curator is reachable (transfer instead).',
    inputSchema: { type: 'object', required: ['projectId'], properties: { projectId: { type: 'string' } } },
  },
  {
    name: 'dashboard_vote',
    description: 'Cast your vote in an open curator election. Auto-tallies once every candidate has voted; winner becomes curator (ties broken deterministically by a hash of the election id, so all instances agree).',
    inputSchema: { type: 'object', required: ['projectId', 'candidate'], properties: { projectId: { type: 'string' }, candidate: { type: 'string', description: 'the participant agent id you vote for as curator' } } },
  },
  {
    name: 'dashboard_close_election',
    description: 'Force-tally an open election with the votes cast so far (use when a candidate went offline and will not vote). Any participant may call it.',
    inputSchema: { type: 'object', required: ['projectId'], properties: { projectId: { type: 'string' } } },
  },
  {
    name: 'dashboard_set_roadmap',
    description: 'Curator-only. Set the project roadmap as a multi-level outline (A. 1. (i)). Accepts a roadmap tree or a Markdown outline string.',
    inputSchema: { type: 'object', required: ['projectId', 'roadmap'], properties: { projectId: { type: 'string' }, roadmap: { description: 'array of {text, repo?, refs?, cause?, children?} or an outline string' } } },
  },
  {
    name: 'dashboard_query',
    description: 'Read entries for a project. Optional filters by repo, category, state, tag, keyword (q), or blocked-only. List results omit tip bodies (entries with one carry hasBody:true); pass entryId to fetch a single entry in full — that is how you read a tip\'s body.',
    inputSchema: {
      type: 'object', required: ['projectId'],
      properties: {
        projectId: { type: 'string' },
        repo: { type: 'string' },
        category: { type: 'string', enum: CATEGORY_ENUM },
        state: { type: 'string' },
        tag: { type: 'string', description: 'match entries carrying this tag (tips are the tagged category)' },
        q: { type: 'string', description: 'case-insensitive keyword over one-liner, tags, and tip bodies' },
        entryId: { type: 'string', description: 'fetch this single entry in full (includes tip body)' },
        blockedOnly: { type: 'boolean' },
      },
    },
  },
  {
    name: 'dashboard_digest',
    description: 'Compact human/agent-readable digest of a project (roadmap + per-category entries). Pass sinceRev for a delta.',
    inputSchema: {
      type: 'object', required: ['projectId'],
      properties: {
        projectId: { type: 'string' },
        repo: { type: 'string' },
        categories: { type: 'array', items: { type: 'string', enum: CATEGORY_ENUM } },
        sinceRev: { type: 'number' },
      },
    },
  },
  {
    name: 'dashboard_chain',
    description: 'Walk the causal chain back from a grounding ref (sha/conv/uri) to its root, reconstructed from entry refs alone.',
    inputSchema: { type: 'object', required: ['fromRef'], properties: { fromRef: { type: 'string', description: 'e.g. "azra://sha/108fa48" or "conv:687b00cb"' } } },
  },
  {
    name: 'dashboard_set_entry',
    description: 'Create/update/file/add a board ENTRY — a task, todo, bug, challenge, nicetohave, adr, or tip. THIS is the tool to create a todo/task/bug (NOT dashboard_set_roadmap, which is curator-only project structure). For a repo you are RESIDENT on — any agent on the same host as the repo\'s owner may write it (box-mates co-curate; not a single named seat). One-liner <=80 chars; actionable categories require >=1 grounding ref. Pointers only, never bodies — except category "tips" (wikihow-style how-to/gotcha): a tip carries a body (<=1500 chars summary) plus tags, and its refs MUST point at the canonical doc the body summarizes.',
    inputSchema: {
      type: 'object', required: ['projectId', 'repo', 'category', 'oneliner'],
      properties: {
        projectId: { type: 'string' },
        repo: { type: 'string', description: 'a repo you are resident on (same host as its owner); the entry is attributed to that repo\'s owner agent' },
        category: { type: 'string', enum: CATEGORY_ENUM },
        oneliner: { type: 'string', description: 'HARD LIMIT 80 chars — count before sending, the server rejects 81 (top recurring agent error); no "::"; details live in the referenced artifact' },
        refs: { type: 'array', items: { type: 'string' }, description: 'grounding refs. Grammar: <repo>://sha/<hash>, <repo>://pr/<N>, <repo>://adr/<N>, <repo>://entry/<id>, <repo>://file/<path>[:line], file:<path>, conv:<uuid>. <repo> must be a repo mapped into the project — unknown prefixes come back as warnings; fix them, a typo poisons the provenance chain' },
        body: { type: 'string', description: 'tips only: the how-to/gotcha summary, HARD LIMIT 1500 chars (blank lines collapse to single newlines); over the cap → trim the summary, the ref\'d doc stays canonical' },
        tags: { type: 'array', items: { type: 'string' }, description: 'tips only: lowercase keywords for dashboard_query {tag} lookup' },
        state: { type: 'string', enum: ['open', 'in_progress', 'claimed'], description: 'claim work: in_progress (alias claimed) signals you are doing this; response surfaces other in-progress entries to catch duplicate parallel work' },
        causal_parent: { type: 'string', description: 'ref this entry was caused by (chains the causal DAG)' },
        entryId: { type: 'string', description: 'present = update that entry; absent = create' },
        ifRev: { type: 'number', description: 'optimistic concurrency: reject if project rev moved. RECOMMENDED on every update (entryId set) when multiple agents share the project — read the rev via dashboard_query/digest first; skip for creates' },
      },
    },
  },
  {
    name: 'dashboard_close_entry',
    description: 'Close an entry. Any agent resident on the owner\'s host (or the user) may close. Pass status:"wontfix" to mark won\'t-fix.',
    inputSchema: { type: 'object', required: ['projectId', 'entryId'], properties: { projectId: { type: 'string' }, entryId: { type: 'string' }, status: { type: 'string', enum: ['closed', 'wontfix'] } } },
  },
  {
    name: 'dashboard_comment_entry',
    description: 'Append an audit-only comment to an entry (any project participant). Never mutates the entry body.',
    inputSchema: { type: 'object', required: ['projectId', 'entryId', 'text'], properties: { projectId: { type: 'string' }, entryId: { type: 'string' }, text: { type: 'string' } } },
  },
  {
    name: 'dashboard_promote',
    description: 'Re-file an entry into another category in place (owner-host residents only). Same id-lineage, no duplication.',
    inputSchema: { type: 'object', required: ['projectId', 'entryId', 'toCategory'], properties: { projectId: { type: 'string' }, entryId: { type: 'string' }, toCategory: { type: 'string', enum: CATEGORY_ENUM } } },
  },
  {
    name: 'dashboard_link',
    description: 'Add typed links from an entry to other entries/refs (owner-host residents only). Link, don\'t copy. supersedes/caused-by also extend dashboard_chain.',
    inputSchema: {
      type: 'object', required: ['projectId', 'entryId', 'targets'],
      properties: {
        projectId: { type: 'string' },
        entryId: { type: 'string' },
        rel: { type: 'string', enum: ['blocked-on', 'supersedes', 'caused-by'], description: 'edge type (default blocked-on)' },
        targets: { type: 'array', items: { type: 'string' }, description: 'entry ids or refs this edge points at' },
      },
    },
  },
];

module.exports = { DASHBOARD_TOOLS };
