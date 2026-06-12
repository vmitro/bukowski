// src/mcp/eventTools.js - MCP tool definitions for subscribeable coordination
// events. Shared verbatim by the server (MCPServer._defineTools) and the bridge
// (static TOOLS) so the two lists can never drift. Handlers live in
// MCPServer._handleToolCall. See src/events/EventBus.js for the model.

const EVENT_TOOLS = [
  {
    name: 'event_publish',
    description: 'Publish a coordination EVENT (a fact with a timestamp: "broker up", "task-3 closed", "commit pushed") to a topic. Events are NOT messages — they never enter anyone\'s FIPA inbox and never block a stop-hook; subscribers consume them at leisure via event_poll. Use FIPA for arguments-with-evidence, events for facts-with-timestamps. Dashboard mutations already auto-publish to dashboard:<project>:entries — do not re-publish those.',
    inputSchema: {
      type: 'object', required: ['topic'],
      properties: {
        topic: { type: 'string', description: 'kind[:scope]:name, colon-namespaced, free-form (no registration). Conventions: repo:<name>:commits, deploy:<name>:lifecycle, dashboard:<project>:entries, agent:<id>:status' },
        payload: { description: 'arbitrary JSON fact (<=4096 bytes stringified); link larger artifacts, do not inline them' },
      },
    },
  },
  {
    name: 'event_subscribe',
    description: 'Subscribe to a topic pattern. ACKED: returns only once the subscription is durable, and hands back the retained backlog (last-N per matching topic) inline so a late joiner is caught up in the same call — no subscribe-then-publish race. "*" stands for one whole segment; a trailing "*" matches the rest (e.g. dashboard:*:entries, repo:meddaemon:*).',
    inputSchema: {
      type: 'object', required: ['pattern'],
      properties: { pattern: { type: 'string', description: 'topic or wildcard pattern, e.g. "deploy:meddaemon:lifecycle" or "dashboard:*:entries"' } },
    },
  },
  {
    name: 'event_unsubscribe',
    description: 'Remove a subscription pattern you previously added (exact pattern string).',
    inputSchema: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' } } },
  },
  {
    name: 'event_poll',
    description: 'Drain your pending events. event_poll is the authoritative delivery path — events never block a stop-hook. As a courtesy, an idle subscriber also gets a non-blocking <channel> nudge (kind:"event") when its queue first goes non-empty, telling it to poll; bursts coalesce to one nudge, and you may simply poll at your own cadence regardless. Returns events in publish order plus remaining count and a dropped count (events shed when your queue overflowed since the last poll).',
    inputSchema: { type: 'object', properties: { max: { type: 'number', description: 'max events to return (default 50)' } } },
  },
  {
    name: 'event_topics',
    description: 'Introspection: list known topics with retained/published counts and live listener counts, OR pass a topic to see exactly who listens (use before publishing to avoid firing into the void).',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', description: 'if set, return who_listens for this exact topic instead of the topic list' } } },
  },
];

module.exports = { EVENT_TOOLS };
