#!/usr/bin/env node
// Event-bus smoke. Coordination events (subscribeable facts) must:
//   - publish to free-form colon topics, reject malformed/oversized
//   - subscribe ACKED with retained backlog inline (no subscribe/publish race)
//   - fan out by exact + wildcard patterns, never echo to the publisher
//   - poll consume-at-leisure, bound the per-subscriber queue + count drops
//   - introspect topics + who-listens (kills fire-into-void)
//   - NEVER block a stop-hook (structurally separate from FIPA queues)

'use strict';

const assert = require('assert');
const { EventBus, patternMatches } = require('../../src/events/EventBus');

function expectErr(code, fn) {
  try { fn(); } catch (e) { assert(e.message.includes(code), `expected ${code}, got: ${e.message}`); return; }
  assert.fail(`expected ${code} to throw`);
}

// ── pattern matching unit ────────────────────────────────────────────────
assert(patternMatches('dashboard:proj:entries', 'dashboard:proj:entries'), 'exact match');
assert(patternMatches('dashboard:*:entries', 'dashboard:proj:entries'), 'mid wildcard');
assert(patternMatches('repo:meddaemon:*', 'repo:meddaemon:commits'), 'trailing wildcard');
assert(!patternMatches('dashboard:*:entries', 'dashboard:proj:roadmap'), 'wildcard respects fixed segments');
assert(!patternMatches('repo:meddaemon:commits', 'repo:azra:commits'), 'non-match');
console.log('OK: topic pattern matching (exact, mid-*, trailing-*)');

// ── publish validation ───────────────────────────────────────────────────
const bus = new EventBus({ host: 'testbox' });
expectErr('BAD_TOPIC', () => bus.publish('singlesegment', {}));
expectErr('BAD_TOPIC', () => bus.publish('has:*:wildcard', {}));
expectErr('EVENT_TOO_BIG', () => bus.publish('deploy:x:lifecycle', { blob: 'x'.repeat(5000) }));
console.log('OK: publish rejects malformed topics + oversized payloads');

// ── acked subscribe returns retained backlog inline (late-joiner catchup) ──
bus.publish('deploy:meddaemon:lifecycle', { state: 'up' }, { actor: 'claude-meddaemon-1' });
bus.publish('deploy:meddaemon:lifecycle', { state: 'bounce' }, { actor: 'claude-meddaemon-1' });
const sub = bus.subscribe('claude-azra-1', 'deploy:meddaemon:lifecycle');
assert.strictEqual(sub.ok, true);
assert.strictEqual(sub.retained.length, 2, 'subscribe hands back retained events inline');
assert.deepStrictEqual(sub.retained.map((e) => e.payload.state), ['up', 'bounce'], 'retained in publish order');
console.log('OK: subscribe is acked + returns retained backlog (no race)');

// ── fan-out: live delivery, publisher never hears itself ───────────────────
bus.subscribe('claude-bukowski-1', 'deploy:*:lifecycle');
const live = bus.publish('deploy:meddaemon:lifecycle', { state: 'degraded' }, { actor: 'claude-meddaemon-1' });
assert.strictEqual(live.subscribers, 2, 'azra (exact) + bukowski (wildcard) both receive');
const selfPub = bus.publish('deploy:azra:lifecycle', { state: 'up' }, { actor: 'claude-bukowski-1' });
assert.strictEqual(selfPub.subscribers, 0, 'publisher is not delivered its own event (only bukowski subscribes deploy:*)');
console.log('OK: fan-out by exact+wildcard; publisher excluded from its own event');

// ── poll drains in order, then empties ─────────────────────────────────────
const polled = bus.poll('claude-azra-1');
assert.strictEqual(polled.events.length, 1, 'azra has the one live degraded event (retained backlog came via subscribe, not the queue)');
assert.strictEqual(polled.events[0].payload.state, 'degraded');
assert.strictEqual(bus.poll('claude-azra-1').events.length, 0, 'second poll is empty');
console.log('OK: poll drains pending events in order, then empties');

// ── fire-into-void warning + introspection ─────────────────────────────────
const voidPub = bus.publish('agent:nobody:status', { busy: true });
assert(voidPub.warning && /nothing listens/.test(voidPub.warning), 'publish into a topic with no listeners warns');
const who = bus.whoListens('deploy:meddaemon:lifecycle');
assert(who.includes('claude-azra-1') && who.includes('claude-bukowski-1'), 'whoListens resolves wildcard + exact subscribers');
const topics = bus.topicsInfo();
assert(topics.find((t) => t.topic === 'deploy:meddaemon:lifecycle')?.listeners === 2, 'topicsInfo carries live listener counts');
console.log('OK: fire-into-void warning + topic/who-listens introspection');

// ── bounded queue: drop-oldest with a surfaced drop counter ────────────────
const small = new EventBus({ queueCap: 3, host: 'testbox' });
small.subscribe('sink', 'flood:x:tick');
for (let i = 0; i < 10; i++) small.publish('flood:x:tick', { i }, { actor: 'src' });
const drained = small.poll('sink', 100);
assert.strictEqual(drained.events.length, 3, 'queue bounded to cap');
assert.strictEqual(drained.dropped, 7, 'dropped count surfaced');
assert.deepStrictEqual(drained.events.map((e) => e.payload.i), [7, 8, 9], 'drop-oldest keeps the newest');
assert.strictEqual(small.poll('sink').dropped, 0, 'drop counter resets after surfacing');
console.log('OK: per-subscriber queue bounded (drop-oldest), drop count surfaced + reset');

// ── retained ring bounded per topic ────────────────────────────────────────
const ring = new EventBus({ retainN: 5, host: 'testbox' });
for (let i = 0; i < 12; i++) ring.publish('r:x:n', { i }, { actor: 'src' });
const late = ring.subscribe('latecomer', 'r:x:n');
assert.strictEqual(late.retained.length, 5, 'retained ring capped at retainN');
assert.deepStrictEqual(late.retained.map((e) => e.payload.i), [7, 8, 9, 10, 11], 'retains the newest N');
console.log('OK: retained ring bounded per topic (newest-N for late joiners)');

// ── unsubscribe stops delivery ─────────────────────────────────────────────
bus.unsubscribe('claude-azra-1', 'deploy:meddaemon:lifecycle');
const after = bus.publish('deploy:meddaemon:lifecycle', { state: 'up' }, { actor: 'claude-meddaemon-1' });
assert.strictEqual(after.subscribers, 1, 'only bukowski (wildcard) remains after azra unsubscribes');
console.log('OK: unsubscribe stops delivery');

// ── cross-box federation: local publish forwards, remote injects, no loop ──
// Models multi.js wiring: 'published' (local only) → peer.broadcastEvent;
// peer 'event' → injectRemote (no re-emit). Two buses, hand-wired both ways.
const boxA = new EventBus({ host: 'azra' });
const boxB = new EventBus({ host: 'meddaemon' });
let aFwd = 0, bFwd = 0;
boxA.on('published', (ev) => { aFwd++; boxB.injectRemote(ev); });   // A→B
boxB.on('published', (ev) => { bFwd++; boxA.injectRemote(ev); });   // B→A
// meddaemon's box subscribes to an azra-side topic (the cross-boundary case)
boxB.subscribe('agent:azra-agent-1:status', 'agent:azra-agent-1:status');
const fwd = boxA.publish('agent:azra-agent-1:status', { trainingDone: true }, { actor: 'claude-azra-agent-1' });
assert.strictEqual(fwd.subscribers, 0, 'no LOCAL subscriber on box A');
assert.strictEqual(aFwd, 1, 'local publish emitted "published" exactly once (forwarded to peer)');
const bGot = boxB.poll('agent:azra-agent-1:status');
assert.strictEqual(bGot.events.length, 1, 'remote subscriber on box B received the forwarded event');
assert.strictEqual(bGot.events[0].host, 'azra', 'forwarded event keeps its origin host');
assert.strictEqual(bGot.events[0].payload.trainingDone, true, 'payload intact across the boundary');
// the inject on B must NOT re-emit 'published' → no bounce-back storm
assert.strictEqual(bFwd, 0, 'injected remote event does not re-forward (no federation loop)');
console.log('OK: cross-box event forwarding (origin preserved, no re-emit loop)');

// ── courtesy wake: coalesced empty→non-empty, re-armed after poll ──────────
const wbus = new EventBus({ host: 'testbox' });
const wakes = [];
wbus.on('wake', ({ agentId, topic }) => wakes.push({ agentId, topic }));
wbus.subscribe('sleeper', 'agent:x:status');
wbus.publish('agent:x:status', { n: 1 }, { actor: 'src' });
wbus.publish('agent:x:status', { n: 2 }, { actor: 'src' });
wbus.publish('agent:x:status', { n: 3 }, { actor: 'src' });
assert.strictEqual(wakes.length, 1, 'a burst to an un-polled subscriber wakes exactly once (coalesced)');
assert.deepStrictEqual(wakes[0], { agentId: 'sleeper', topic: 'agent:x:status' }, 'wake carries agent + triggering topic');
wbus.poll('sleeper'); // drain → re-arm
wbus.publish('agent:x:status', { n: 4 }, { actor: 'src' });
assert.strictEqual(wakes.length, 2, 'next event after poll re-arms the wake');
// publisher never wakes itself; no wake when nobody's queue transitions
wbus.subscribe('src', 'agent:x:status');
wbus.publish('agent:x:status', { n: 5 }, { actor: 'src' });
assert.strictEqual(wakes.filter((w) => w.agentId === 'src').length, 0, 'publisher is never woken for its own event');
console.log('OK: courtesy wake coalesces a burst, re-arms after poll, skips publisher');

console.log('OK: events smoke passed');
process.exit(0);
