#!/usr/bin/env node
/**
 * Socket binding: an MCP bridge must land on the instance that owns its
 * working directory, not on whichever instance happens to sit in its process
 * ancestry.
 *
 * Regression guard for the codex cross-binding: codex's app-server-daemon is
 * machine-global, so a codex session's bridge is spawned as a child of the
 * bukowski that first started the daemon. The projects pane's codex therefore
 * resolved to the azra-agent instance, answered as codex-azra-agent-1, and
 * never saw the messages queued for it on its own instance.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  pidFromFileName,
  readInstanceMeta,
  isWithin,
  instanceCwd,
  instanceSocket,
  instancesOwningCwd,
  instancesWithCwd,
  pidFromSocketPath,
  socketIsLive,
  chooseSocket,
  betterOwnerThan,
} = require('../../src/mcp/socketDiscovery');

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}`); }
}

// ---------------------------------------------------------------- scratch dir
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bukowski-sockbind-'));
const sockets = {};
function instance(pid, cwd) {
  const sock = path.join(dir, `s-${pid}.sock`);
  fs.writeFileSync(sock, '');           // stand-in for a live socket
  fs.writeFileSync(path.join(dir, String(pid)), sock);
  fs.writeFileSync(path.join(dir, `${pid}.meta`), JSON.stringify({ socket: sock, pid, cwd }));
  sockets[pid] = sock;
}

// The real box: a broad instance at ~/projects and a nested one beneath it.
const PROJECTS = '/home/sheemeh/projects';
const AZRA = '/home/sheemeh/projects/azra-agent';
instance(3525338, PROJECTS);
instance(846624, AZRA);
const allRunning = () => true;
const owners = (cwd) => instancesOwningCwd(cwd, { dir, isRunning: allRunning });

console.log('1. strict pid file naming');
ok(pidFromFileName('3525338') === 3525338, 'a bare pid parses');
ok(isNaN(pidFromFileName('3525338.meta')), 'the sidecar is NOT read as a pid');
ok(isNaN(pidFromFileName('')) && isNaN(pidFromFileName('abc')), 'junk names rejected');
ok(isNaN(pidFromFileName('12abc')), 'a pid prefix alone does not qualify');

console.log('2. containment');
ok(isWithin(PROJECTS, PROJECTS), 'a directory contains itself');
ok(isWithin(PROJECTS, AZRA), 'a parent contains its child');
ok(!isWithin(AZRA, PROJECTS), 'a child does not contain its parent');
ok(!isWithin(PROJECTS, '/home/sheemeh/projects-old'),
  'a sibling sharing a name prefix is not inside (path-segment aware)');
ok(!isWithin(null, PROJECTS) && !isWithin(PROJECTS, null), 'missing paths never match');

console.log('3. the codex cross-binding this fixes');
const fromProjects = owners(PROJECTS);
ok(fromProjects.length === 1, 'a bridge in ~/projects has exactly one candidate');
ok(fromProjects[0].pid === 3525338, 'it binds to the projects instance');
ok(fromProjects[0].socket === sockets[3525338], 'and to that instance\'s socket');
ok(!fromProjects.some((o) => o.pid === 846624),
  'the azra-agent instance is NOT a candidate — its cwd cannot contain ours');

console.log('4. deepest cwd wins');
const fromAzra = owners(AZRA);
ok(fromAzra.length === 2, 'a bridge in ~/projects/azra-agent matches both instances');
ok(fromAzra[0].pid === 846624, 'the nested instance is preferred over the broad one');
ok(fromAzra[1].pid === 3525338, 'the broad instance remains a fallback, ranked lower');

console.log('5. a bridge outside every instance');
ok(owners('/var/tmp').length === 0, 'no candidate is invented for an unrelated cwd');

console.log('6. liveness and socket presence are required');
ok(instancesOwningCwd(PROJECTS, { dir, isRunning: () => false }).length === 0,
  'a dead instance is never a candidate');
const deadSock = instancesOwningCwd(PROJECTS, {
  dir, isRunning: allRunning, exists: (p) => p !== sockets[3525338],
});
ok(!deadSock.some((o) => o.pid === 3525338),
  'an instance whose socket file is gone is skipped');

console.log('7. pre-upgrade instances (no sidecar)');
const legacyPid = 1806778;
const legacySock = path.join(dir, `s-${legacyPid}.sock`);
fs.writeFileSync(legacySock, '');
fs.writeFileSync(path.join(dir, String(legacyPid)), legacySock);   // no .meta
ok(readInstanceMeta(legacyPid, dir) === null, 'a missing sidecar reads as null');
ok(!owners(PROJECTS).some((o) => o.pid === legacyPid),
  'an instance making no cwd claim is not a cwd candidate');
ok(owners(PROJECTS).length === 1 && owners(PROJECTS)[0].pid === 3525338,
  'and it does not displace the instance that does claim our cwd');

console.log('8. malformed sidecar');
const badPid = 999001;
fs.writeFileSync(path.join(dir, String(badPid)), path.join(dir, 'nope.sock'));
fs.writeFileSync(path.join(dir, `${badPid}.meta`), '{not json');
ok(readInstanceMeta(badPid, dir) === null, 'unparseable JSON reads as null, no throw');
const noCwdPid = 999002;
fs.writeFileSync(path.join(dir, String(noCwdPid)), path.join(dir, 'nope2.sock'));
fs.writeFileSync(path.join(dir, `${noCwdPid}.meta`), JSON.stringify({ socket: 'x', pid: noCwdPid }));
ok(readInstanceMeta(noCwdPid, dir) === null, 'a sidecar without cwd reads as null');
ok(owners(PROJECTS).length === 1, 'malformed sidecars add no candidates');

console.log('9. ordering is stable');
instance(2000001, PROJECTS);
instance(2000002, PROJECTS);
const tied = owners(PROJECTS).filter((o) => o.cwd === PROJECTS);
ok(tied.length === 3, 'three instances claim the same cwd');
ok(tied[0].pid < tied[1].pid && tied[1].pid < tied[2].pid,
  'equal-depth candidates are ordered by pid, not by readdir order');

console.log('10. durable cwd: un-upgraded instances still claim their own cwd');
// An instance with a pid file and socket but NO sidecar — the pre-sidecar
// fleet. If it could not claim its cwd, the shallower upgraded instance at
// ~/projects would capture bridges belonging to it.
const oldPid = 777001;   // distinct from block 1's instances, which have sidecars
const oldSock = path.join(dir, `s-${oldPid}.sock`);
fs.writeFileSync(oldSock, '');
fs.writeFileSync(path.join(dir, String(oldPid)), oldSock);   // no .meta
// Only the un-upgraded instance needs a kernel cwd; the rest have sidecars.
const cwdOf = (pid) => (pid === oldPid ? AZRA : null);
ok(readInstanceMeta(oldPid, dir) === null, 'the un-upgraded instance has no sidecar');
ok(instanceCwd(oldPid, dir, cwdOf) === AZRA, 'its cwd comes from the kernel instead');
ok(instanceSocket(oldPid, dir) === oldSock, 'its socket comes from the bare pid file');
const nested = instancesOwningCwd(AZRA, { dir, isRunning: allRunning, cwdOf });
ok(nested[0].pid === oldPid,
  'a bridge in ~/projects/azra-agent prefers the un-upgraded DEEPER instance');
ok(nested.some((o) => o.cwd === PROJECTS),
  'the shallower upgraded instance is still a lower-ranked fallback');

console.log('11. chooseSocket: env is kept when it is consistent or unopposed');
const projSock = sockets[3525338];
ok(chooseSocket({ envPath: projSock, envExists: true, owners: owners(PROJECTS) }).via === 'env',
  'env naming an instance that owns our cwd is used as-is');
ok(chooseSocket({ envPath: projSock, envExists: true, owners: [] }).via === 'env',
  'env is kept when NO instance owns our cwd (a pane that cd\'d away)');
ok(chooseSocket({ envPath: '/tmp/gone.sock', envExists: false, owners: owners(PROJECTS) }).via === 'cwd',
  'a vanished env socket falls through to cwd ownership');
ok(chooseSocket({ envPath: null, envExists: false, owners: [] }) === null,
  'nothing to go on returns null so later stages run');

console.log('12. chooseSocket: the bug-22 override');
// The bg-spare case: env points at azra-agent, our cwd is ~/projects.
const azraSock = sockets[846624];
const decision = chooseSocket({
  envPath: azraSock, envExists: true, owners: owners(PROJECTS),
});
ok(decision.via === 'cwd-override', 'inherited env that does not own our cwd is overridden');
ok(decision.socket === owners(PROJECTS)[0].socket,
  'and we bind to the best-ranked instance that does own it');
ok(decision.overridden === azraSock, 'the rejected env path is reported for the log line');
ok(chooseSocket({ envPath: azraSock, envExists: true, owners: owners(AZRA) }).via === 'env',
  'the same env is honoured for a bridge genuinely under azra-agent');

console.log('13. a socket file is not proof of a live instance');
// respawn-pane -k SIGKILLs, so /tmp keeps the dead instance's socket file.
// Trusting existence alone is what left azra-agent's codex dialling a socket
// nobody listened on while its client still showed 38 tools.
ok(pidFromSocketPath('/tmp/bukowski-mcp-846624.sock') === 846624, 'pid parses out of the path');
ok(isNaN(pidFromSocketPath('/tmp/custom.sock')), 'an unattributable path yields NaN');
const live = { exists: () => true, isRunning: (pid) => pid === 1246758 };
ok(socketIsLive('/tmp/bukowski-mcp-1246758.sock', live), 'live instance → usable');
ok(!socketIsLive('/tmp/bukowski-mcp-846624.sock', live),
  'leftover file from a dead instance → NOT usable');
ok(!socketIsLive('/tmp/bukowski-mcp-1246758.sock', { exists: () => false, isRunning: () => true }),
  'missing file → not usable even if the pid lives');
ok(socketIsLive('/tmp/custom.sock', live),
  'a custom path we cannot attribute is taken at face value, not rejected');
ok(!socketIsLive(null, live) && !socketIsLive('', live), 'empty input is never live');

console.log('14. a dead env socket no longer wins the choice');
const deadEnv = '/tmp/bukowski-mcp-846624.sock';
ok(chooseSocket({ envPath: deadEnv, envExists: socketIsLive(deadEnv, live), owners: owners(PROJECTS) }).via === 'cwd',
  'dead env socket falls through to cwd ownership instead of being dialled');

console.log('15. a bound bridge re-evaluates ownership (bug-25)');
// azra's codex bound to ~/projects while its own instance was briefly down,
// then stayed there for 20 minutes because the link was healthy.
const azraOwners = owners(AZRA);                  // [azra (deep), projects (shallow)]
const deepSock = sockets[846624];
const projSock2 = sockets[3525338];
ok(azraOwners[0].socket === deepSock, 'the deeper instance ranks first');
ok(betterOwnerThan(deepSock, azraOwners) === null, 'already on the deepest owner → stay');
const move = betterOwnerThan(projSock2, azraOwners);
ok(move && move.socket === deepSock, 'bound to the shallow ancestor → move to the deeper one');
ok(betterOwnerThan('/tmp/bukowski-mcp-999999.sock', azraOwners).socket === deepSock,
  'bound to an instance that owns nothing of ours → move');
ok(betterOwnerThan(null, azraOwners).socket === deepSock, 'unbound → take the best');
ok(betterOwnerThan(deepSock, []) === null, 'no owners at all → never churn');
ok(betterOwnerThan(deepSock, null) === null, 'missing owner list is tolerated');
// Equal depth must not ping-pong: three instances share PROJECTS in this dir.
const tied2 = owners(PROJECTS).filter((o) => o.cwd === PROJECTS);
ok(tied2.length >= 2, 'several instances claim the same depth');
ok(betterOwnerThan(tied2[1].socket, owners(PROJECTS)) === null,
  'equal-depth owner is not a reason to rebind (no flapping)');

console.log('16. finding the same instance again after it restarts');
// A restart changes the instance's pid and socket path and keeps its cwd, so
// the cwd is the only durable handle a reconnecting bridge has on "the seat I
// had". Without it the fallback is "whichever instance was touched most
// recently", which quietly relocates the agent to another project's roster.
const withCwd = (cwd) => instancesWithCwd(cwd, { dir, isRunning: allRunning });
ok(withCwd(AZRA).length === 1, 'exactly the instance sitting in that directory');
ok(withCwd(AZRA)[0].pid === 846624, 'identified by pid');
ok(withCwd(PROJECTS).every((i) => i.cwd === PROJECTS), 'never a parent or a child');
ok(!withCwd(PROJECTS).some((i) => i.pid === 846624),
  'the nested instance does NOT answer for its parent directory');
ok(withCwd(`${AZRA}/`).length === 1, 'a trailing slash is the same directory');
ok(withCwd('/home/sheemeh/projects/azra-agent-old').length === 0,
  'a directory with a shared prefix is not it');
ok(withCwd(null).length === 0 && withCwd('').length === 0, 'no remembered directory → no claim');
ok(withCwd('/nowhere').length === 0, 'a vanished directory finds nothing, rather than guessing');
// Replacement: same cwd, new pid, new socket — which is what a restart is.
instance(3999001, AZRA);
const afterRestart = withCwd(AZRA);
ok(afterRestart.length === 2, 'both the old and the new instance answer while both live');
ok(afterRestart[0].pid === 846624 && afterRestart[1].pid === 3999001,
  'ordered by pid, so the choice is not arbitrary run to run');

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('OK: socket-binding smoke passed');
