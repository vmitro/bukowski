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
  instancesOwningCwd,
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

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('OK: socket-binding smoke passed');
