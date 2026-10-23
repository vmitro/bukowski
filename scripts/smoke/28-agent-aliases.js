#!/usr/bin/env node
/**
 * Agents name themselves, and the name is the address.
 *
 * Generated ids are the wrong thing to coordinate on. A pane id (codex-1)
 * reaches a screen; an external seat (codex-projects-4) reaches a tools inbox;
 * the seat number changes on every instance restart, daemon bounce and /clear;
 * and neither name says which agent is doing which job. On 2026-10-23 the
 * projects instance restarted three times, a codex reviewer's seat walked
 * -2 -> -8 -> -4 -> -3, two agents each claimed to be codex-projects-3, and an
 * ADR-46 review request spent a day arriving at the wrong agent's screen.
 *
 * An alias is the one identity the agent controls. It says "I am assem" once
 * per seat and the fleet addresses `assem` forever.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { MCPServer } = require(path.join(ROOT, 'src', 'mcp', 'MCPServer'));

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}`); }
}

/** A server with the given pane agents, and external seats added by hand. */
function newServer(panes = []) {
  const agents = panes.map((id) => ({ id, name: id, type: id.split('-')[0] }));
  const server = new MCPServer({
    getAllAgents: () => agents,
    getAgent: (id) => agents.find((a) => a.id === id) || null,
  }, null, null, null);
  return server;
}
function addSeat(server, id, type = 'codex', host = 'projects') {
  server.externalAgents.set(id, { type, host, registeredAt: Date.now(), socket: {} });
}

console.log('1. an agent can name itself');
let s = newServer(['codex-1']);
addSeat(s, 'codex-projects-4');
let r = s._claimAlias('codex-projects-4', 'assem');
ok(r.ok === true && r.alias === 'assem', 'the claim succeeds');
ok(s._resolveAlias('assem') === 'codex-projects-4', 'and the name resolves to the seat');
ok(s._resolveAlias('ASSEM') === 'codex-projects-4', 'case-insensitively');
ok(s._claimAlias('codex-projects-4', '  AsSeM  ').ok === true, 'claims are normalised, not rejected');

console.log('2. the name survives what the seat does not');
// The whole point: the seat churns, the alias is re-asserted onto the new one,
// and every sender's address keeps working.
s.externalAgents.delete('codex-projects-4');        // instance restart
ok(s._resolveAlias('assem') === null, 'a name whose owner is gone stops resolving');
addSeat(s, 'codex-projects-7');                      // same agent, new seat
ok(s._claimAlias('codex-projects-7', 'assem').ok === true, 'and is free to re-claim');
ok(s._resolveAlias('assem') === 'codex-projects-7', 'senders addressing "assem" now reach the new seat');

console.log('3. a live name is never silently stolen');
addSeat(s, 'codex-projects-8');
r = s._claimAlias('codex-projects-8', 'assem');
ok(r.ok === false, 'a second agent cannot take it');
ok(/codex-projects-7/.test(r.error || ''), 'and is told who holds it');
ok(s._resolveAlias('assem') === 'codex-projects-7', 'the holder keeps it');
ok(s._claimAlias('codex-projects-7', 'assem').ok === true, 'but the holder may re-affirm its own');

console.log('4. one agent, one name');
ok(s._claimAlias('codex-projects-7', 'reviewer').ok === true, 'claiming again is allowed');
ok(s._resolveAlias('reviewer') === 'codex-projects-7', 'the new name resolves');
ok(s._resolveAlias('assem') === null, 'and the old one is released, not left dangling');
ok(s._claimAlias('codex-projects-8', 'assem').ok === true, 'so another agent may now take it');

console.log('5. a name cannot impersonate the id system');
s = newServer(['codex-1', 'claude-1']);
addSeat(s, 'codex-projects-4');
for (const bad of ['codex-1', 'claude-1']) {
  ok(s._claimAlias('codex-projects-4', bad).ok === false, `${bad} is an existing agent id`);
}
for (const bad of ['codex-projects-2', 'claude-hub-11', 'codex-9', 'chat-3']) {
  const res = s._claimAlias('codex-projects-4', bad);
  ok(res.ok === false && /generated/.test(res.error), `${bad} looks generated and is refused`);
}
ok(s._claimAlias('codex-projects-4', 'user').ok === false, '"user" is reserved for the human');
ok(s._claimAlias('codex-projects-4', 'all').ok === false, '"all" is reserved');
// A name that merely CONTAINS a type is fine: "codexer" is not an id.
ok(s._claimAlias('codex-projects-4', 'codexer').ok === true, 'but a real word is not blocked');

console.log('6. shape rules');
s = newServer();
addSeat(s, 'codex-projects-4');
for (const bad of ['a', '', '1place', '-place', 'PLACE!', 'two words', 'x'.repeat(33)]) {
  ok(s._claimAlias('codex-projects-4', bad).ok === false, `${JSON.stringify(bad)} refused`);
}
ok(s._claimAlias('codex-projects-4', 'place_2').ok === true, 'underscores and digits are fine');
ok(s._claimAlias(null, 'place').ok === false, 'a connection with no identity cannot claim');

async function main() {
  console.log('7. register_agent claims and reports');
  let s = newServer(['codex-1']);
  addSeat(s, 'codex-projects-4');
  let res = await s._handleToolCall('register_agent', { type: 'codex', alias: 'assem' }, 'codex-projects-4');
  ok(res.alias === 'assem', 'the claim is confirmed in the reply');
  ok(res.routableAs[0] === 'assem', 'and leads routableAs — it is the name others should use');
  ok(res.routableAs.includes('codex-projects-4'), 'the seat is still listed');
  addSeat(s, 'codex-projects-5');
  res = await s._handleToolCall('register_agent', { type: 'codex', alias: 'assem' }, 'codex-projects-5');
  ok(res.aliasRefused === 'assem', 'a refusal is reported, not silently dropped');
  ok(/held by codex-projects-4/.test(res.aliasError || ''), 'with the holder named');
  ok(res.registered === true, 'and the seat report still succeeds');
  res = await s._handleToolCall('register_agent', { type: 'codex' }, 'codex-projects-5');
  ok(res.alias === undefined && res.aliasRefused === undefined, 'no alias argument, no alias fields');

  console.log('8. list_agents advertises the chosen name first');
  const listed = await s._handleToolCall('list_agents', {}, 'codex-projects-4');
  const seat = listed.find((a) => a.id === 'codex-projects-4');
  ok(!!seat, 'the seat is listed');
  ok(seat.aliases.includes('assem'), 'carrying its self-chosen name, so a sender can discover it');
  const pane = listed.find((a) => a.id === 'codex-1');
  ok(Array.isArray(pane.aliases), 'pane agents still report aliases');

  console.log('9. a send to a name reaches the agent behind it');
  // Resolution happens before every other lookup, so the alias wins over any
  // generated spelling and the sender never needs to know the seat.
  s = newServer(['codex-1']);
  addSeat(s, 'codex-projects-4');
  s._claimAlias('codex-projects-4', 'assem');
  ok(s._resolveAlias('assem') === 'codex-projects-4', 'alias resolves for the send path');
  ok(s._resolveAlias('place') === null, 'an unclaimed name resolves to nothing (Unknown agent)');
  // Ghost guard: the seat dies, the name must not keep pointing at it.
  s.externalAgents.delete('codex-projects-4');
  ok(s._resolveAlias('assem') === null, 'a dead seat cannot keep swallowing mail under its name');
}

/**
 * The two tool tables must say the same thing.
 *
 * A client can learn the tool list from either side: the bridge answers
 * tools/list from its own static TOOLS array WITHOUT asking bukowski, so that
 * copy is what codex and Claude Code actually cache. When the server's
 * definition changes and the bridge's does not, clients are told something the
 * server no longer implements — register_agent advertised "called
 * automatically by bridge" for a day after it had become an identity report
 * with an alias argument, which is why no agent thought to claim a name.
 */
function toolTablesAgree() {
  console.log('10. the bridge advertises what the server implements');
  const { TOOLS } = require(path.join(ROOT, 'src', 'mcp', 'bukowski-mcp-bridge.js'));
  const server = newServer();
  const serverTools = server._defineTools();
  const byName = (list) => new Map(list.map((t) => [t.name, t]));
  const bridgeMap = byName(TOOLS);
  const serverMap = byName(serverTools);

  const shared = [...bridgeMap.keys()].filter((n) => serverMap.has(n));
  ok(shared.length > 10, `${shared.length} tools defined on both sides`);

  const descDrift = shared.filter((n) => bridgeMap.get(n).description !== serverMap.get(n).description);
  ok(descDrift.length === 0, `no tool description drifts${descDrift.length ? `: ${descDrift.join(', ')}` : ''}`);

  const paramDrift = [];
  for (const n of shared) {
    const b = bridgeMap.get(n).inputSchema?.properties || {};
    const v = serverMap.get(n).inputSchema?.properties || {};
    for (const key of new Set([...Object.keys(b), ...Object.keys(v)])) {
      if (!b[key] || !v[key]) { paramDrift.push(`${n}.${key} (missing on one side)`); continue; }
      if (b[key].description !== v[key].description) paramDrift.push(`${n}.${key}`);
    }
  }
  ok(paramDrift.length === 0, `no parameter drifts${paramDrift.length ? `: ${paramDrift.join(', ')}` : ''}`);

  // The alias is the point of this suite: both sides must offer it and both
  // must tell the caller to prefer it over a seat id.
  ok(!!bridgeMap.get('register_agent')?.inputSchema?.properties?.alias,
    'the bridge offers register_agent.alias');
  const toDesc = bridgeMap.get('fipa_inform').inputSchema.properties.to.description;
  ok(/claimed name/.test(toDesc), 'and every fipa target says a claimed name is addressable');
  ok(/changes on every instance restart/.test(toDesc), 'and says why a seat id should not be cached');
}

main().then(toolTablesAgree).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('OK: agent alias smoke passed');
}).catch((err) => {
  console.log(`  FAIL ${err.stack}`);
  process.exit(1);
});
