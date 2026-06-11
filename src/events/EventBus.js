// src/events/EventBus.js - subscribeable coordination events alongside FIPA.
//
// Events are facts with timestamps ("broker up", "task-3 closed", "commit
// pushed"); FIPA messages are arguments with evidence. The split is
// load-bearing: events NEVER enter the FIPA message queues, so they never
// block an agent's stop-hook — they are consumed at leisure via event_poll.
//
// Design distilled from meddaemon's broker lessons (conv 3954ead5…):
//   - open topic kinds: `kind:scope:name` colon-namespaced, free-form, no
//     registration to publish — consumers invent topics without a schema dance
//   - subscribe is ACKED: subscribe() returns only after the subscription is
//     durable, and hands back the retained backlog inline, so the
//     subscribe-then-publish race cannot exist (no 300ms-sleep hacks)
//   - retained last-N per topic for late joiners (events here are
//     observability facts, not consumed-exactly-once triggers)
//   - everything bounded from day one: retained ring, per-subscriber queue
//     (drop-oldest + a surfaced drop counter), topic count (LRU eviction),
//     payload size — an unbounded app-level queue is an incident later
//   - introspection: topics()/whoListens() turn the silent-no-subscriber
//     failure mode into a one-line warning on publish
//
// Pure in-process data structure: zero MCP/FIPA/federation knowledge.
// Federation forwarding hangs off the 'published' EventEmitter signal
// (local-origin events only; remote injections don't re-emit, so a full-mesh
// peer set cannot loop).

const EventEmitter = require('events');

const RETAIN_N = 50;          // retained events per topic (late-joiner catchup)
const MAX_TOPICS = 500;       // LRU-evicted by last publish time
const QUEUE_CAP = 200;        // per-subscriber pending events (drop-oldest)
const MAX_PAYLOAD = 4096;     // bytes, JSON-stringified
// kind[:scope]:name — 2..4 colon segments, free-form lowercase-ish tokens.
const TOPIC_RE = /^[a-z0-9_.-]+(:[a-z0-9_.\/-]+){1,3}$/i;
// patterns additionally allow '*' as a full segment wildcard
const PATTERN_RE = /^[a-z0-9_.*-]+(:[a-z0-9_.*\/-]+){0,3}$/i;

function eerr(code, message, detail) {
  return new Error('EVENT_ERROR ' + JSON.stringify({ code, message, detail }));
}

/** '*' matches exactly one segment; a trailing '*' also swallows the rest. */
function patternMatches(pattern, topic) {
  const ps = pattern.split(':');
  const ts = topic.split(':');
  for (let i = 0; i < ps.length; i++) {
    if (ps[i] === '*' && i === ps.length - 1) return true; // trailing * = rest
    if (i >= ts.length) return false;
    if (ps[i] !== '*' && ps[i] !== ts[i]) return false;
  }
  return ps.length === ts.length;
}

class EventBus extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.host = opts.host || null;
    this.retainN = opts.retainN || RETAIN_N;
    this.maxTopics = opts.maxTopics || MAX_TOPICS;
    this.queueCap = opts.queueCap || QUEUE_CAP;
    this.seq = 0;
    this.topics = new Map(); // topic -> { retained: [], lastTs, published }
    this.subs = new Map();   // agentId -> Set<pattern>
    this.queues = new Map(); // agentId -> { events: [], dropped }
  }

  _topic(topic) {
    let t = this.topics.get(topic);
    if (!t) {
      if (this.topics.size >= this.maxTopics) {
        // Evict the topic idle the longest; bounded store beats a slow leak.
        let oldest = null, oldestTs = Infinity;
        for (const [k, v] of this.topics) {
          if (v.lastTs < oldestTs) { oldest = k; oldestTs = v.lastTs; }
        }
        if (oldest) this.topics.delete(oldest);
      }
      t = { retained: [], lastTs: 0, published: 0 };
      this.topics.set(topic, t);
    }
    return t;
  }

  /**
   * Publish an event. `meta.remote` marks an event injected from a federated
   * peer: it is stored/fanned out locally but never re-emitted for forwarding.
   * Returns subscriber count + a warning when nobody listens (fire-into-void
   * is the failure mode introspection exists to kill).
   */
  publish(topic, payload, meta = {}) {
    topic = String(topic || '').trim();
    if (!TOPIC_RE.test(topic) || topic.includes('*')) {
      throw eerr('BAD_TOPIC', `topic must be kind[:scope]:name (2-4 colon segments, no wildcards): ${topic}`);
    }
    let size;
    try { size = Buffer.byteLength(JSON.stringify(payload ?? null)); } catch { size = Infinity; }
    if (size > MAX_PAYLOAD) {
      throw eerr('EVENT_TOO_BIG', `payload must be <= ${MAX_PAYLOAD} bytes JSON (got ${size}); events carry facts, link the rest`);
    }
    const ev = {
      topic,
      payload: payload ?? null,
      actor: meta.actor || null,
      host: meta.host || this.host,
      ts: meta.ts || Date.now(),
      seq: ++this.seq,
    };
    const t = this._topic(topic);
    t.retained.push(ev);
    if (t.retained.length > this.retainN) t.retained.shift();
    t.lastTs = ev.ts;
    t.published += 1;

    let delivered = 0;
    for (const [agentId, patterns] of this.subs) {
      if (agentId === ev.actor) continue; // publishers don't hear themselves
      let hit = false;
      for (const p of patterns) { if (patternMatches(p, topic)) { hit = true; break; } }
      if (!hit) continue;
      const q = this.queues.get(agentId) || { events: [], dropped: 0 };
      q.events.push(ev);
      if (q.events.length > this.queueCap) { q.events.shift(); q.dropped += 1; }
      this.queues.set(agentId, q);
      delivered += 1;
    }
    if (!meta.remote) this.emit('published', ev);
    const res = { ok: true, topic, seq: ev.seq, subscribers: delivered };
    if (delivered === 0) res.warning = `nothing listens on '${topic}' (event retained for late joiners; check event_topics)`;
    return res;
  }

  /**
   * Acked subscribe: by the time this returns the subscription is in the
   * fan-out set, and the retained backlog for matching topics comes back
   * inline — the late joiner is caught up in the same call.
   */
  subscribe(agentId, pattern) {
    pattern = String(pattern || '').trim();
    if (!PATTERN_RE.test(pattern)) {
      throw eerr('BAD_TOPIC', `invalid topic pattern: ${pattern} ('*' may stand for a whole segment; trailing '*' matches the rest)`);
    }
    if (!this.subs.has(agentId)) this.subs.set(agentId, new Set());
    this.subs.get(agentId).add(pattern);
    const retained = [];
    for (const [topic, t] of this.topics) {
      if (patternMatches(pattern, topic)) retained.push(...t.retained);
    }
    retained.sort((a, b) => a.seq - b.seq);
    return { ok: true, subscribed: pattern, retained };
  }

  unsubscribe(agentId, pattern) {
    const set = this.subs.get(agentId);
    const had = !!set && set.delete(String(pattern || '').trim());
    if (set && set.size === 0) this.subs.delete(agentId);
    return { ok: true, unsubscribed: had };
  }

  /** Drain (up to max) pending events for an agent. Consume-at-leisure. */
  poll(agentId, max = 50) {
    const q = this.queues.get(agentId);
    if (!q) return { ok: true, events: [], remaining: 0, dropped: 0 };
    const events = q.events.splice(0, Math.max(1, max));
    const res = { ok: true, events, remaining: q.events.length, dropped: q.dropped };
    q.dropped = 0; // surfaced once, then reset
    return res;
  }

  /** Introspection: every known topic with counts, or listeners of one. */
  topicsInfo() {
    const out = [];
    for (const [topic, t] of this.topics) {
      out.push({ topic, retained: t.retained.length, published: t.published, lastTs: t.lastTs, listeners: this.whoListens(topic).length });
    }
    return out.sort((a, b) => b.lastTs - a.lastTs);
  }

  whoListens(topic) {
    const out = [];
    for (const [agentId, patterns] of this.subs) {
      for (const p of patterns) {
        if (patternMatches(p, topic)) { out.push(agentId); break; }
      }
    }
    return out;
  }

  subscriptionsOf(agentId) {
    return [...(this.subs.get(agentId) || [])];
  }
}

module.exports = { EventBus, patternMatches, _internals: { RETAIN_N, MAX_TOPICS, QUEUE_CAP, MAX_PAYLOAD } };
