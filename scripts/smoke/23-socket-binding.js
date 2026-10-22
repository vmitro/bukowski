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
  chooseSocket,
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

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('OK: socket-binding smoke passed');
