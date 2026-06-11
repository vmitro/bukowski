// src/mcp/dashboardTools.js - MCP tool definitions for the FIPA-native project
// dashboard. Shared verbatim by the server (MCPServer._defineTools) and the
// bridge (static TOOLS, advertised even when bukowski is down) so the two lists
// can never drift. Handlers live in MCPServer._handleToolCall.

const CATEGORY_ENUM = ['description', 'challenges', 'tasks', 'todos', 'nicetohaves', 'bugs', 'adrs'];

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
    description: 'Curator-only. Replace a project\'s repo map (and re-derive participants).',
    inputSchema: { type: 'object', required: ['projectId', 'repos'], properties: { projectId: { type: 'string' }, repos: { type: 'array', items: repoItem } } },
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
    description: 'Read entries for a project. Optional filters by repo, category, state, or blocked-only.',
    inputSchema: {
      type: 'object', required: ['projectId'],
      properties: {
        projectId: { type: 'string' },
        repo: { type: 'string' },
        category: { type: 'string', enum: CATEGORY_ENUM },
        state: { type: 'string' },
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
    description: 'Create or update an entry you own (you must own the target repo). One-liner <=80 chars; actionable categories require >=1 grounding ref. Pointers only, never bodies.',
    inputSchema: {
      type: 'object', required: ['projectId', 'repo', 'category', 'oneliner'],
      properties: {
        projectId: { type: 'string' },
        repo: { type: 'string', description: 'repo you own; the entry is attributed to its owner agent' },
        category: { type: 'string', enum: CATEGORY_ENUM },
        oneliner: { type: 'string', description: '<=80 chars, no "::"; details live in the referenced artifact' },
        refs: { type: 'array', items: { type: 'string' }, description: 'grounding refs: meddaemon://sha/x, meddaemon://adr/27, conv:abc, file:line' },
        state: { type: 'string', enum: ['open', 'in_progress', 'claimed'], description: 'claim work: in_progress (alias claimed) signals you are doing this; response surfaces other in-progress entries to catch duplicate parallel work' },
        causal_parent: { type: 'string', description: 'ref this entry was caused by (chains the causal DAG)' },
        entryId: { type: 'string', description: 'present = update that entry; absent = create' },
        ifRev: { type: 'number', description: 'optimistic concurrency: reject if project rev moved' },
      },
    },
  },
  {
    name: 'dashboard_close_entry',
    description: 'Close an entry. Only the entry owner (or the user) may close. Pass status:"wontfix" to mark won\'t-fix.',
    inputSchema: { type: 'object', required: ['projectId', 'entryId'], properties: { projectId: { type: 'string' }, entryId: { type: 'string' }, status: { type: 'string', enum: ['closed', 'wontfix'] } } },
  },
  {
    name: 'dashboard_comment_entry',
    description: 'Append an audit-only comment to an entry (any project participant). Never mutates the entry body.',
    inputSchema: { type: 'object', required: ['projectId', 'entryId', 'text'], properties: { projectId: { type: 'string' }, entryId: { type: 'string' }, text: { type: 'string' } } },
  },
  {
    name: 'dashboard_promote',
    description: 'Re-file an entry into another category in place (owner-only). Same id-lineage, no duplication.',
    inputSchema: { type: 'object', required: ['projectId', 'entryId', 'toCategory'], properties: { projectId: { type: 'string' }, entryId: { type: 'string' }, toCategory: { type: 'string', enum: CATEGORY_ENUM } } },
  },
  {
    name: 'dashboard_link',
    description: 'Add typed links from an entry to other entries/refs (owner-only). Link, don\'t copy. supersedes/caused-by also extend dashboard_chain.',
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
