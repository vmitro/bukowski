#!/usr/bin/env node
// Federation routing when two bukowskis end up in the "same dir" — i.e.
// PeerRegistry suffixes the second one so their resolved hosts differ.
// We spawn three bukowski-flavored hubs (A=azra, B=azra-<hash>, M=meddaemon)
// using PeerRegistry + FederationHub directly (no multi.js, no node-pty)
// and assert:
//
//   1. M sees BOTH A and B as distinct peers and distinct federatedIds.
//   2. A forward addressed to A's federatedId lands on A (not B).
//   3. A forward addressed to B's federatedId lands on B (not A).
//
// If the federation has the bug the user reported, (2) and (3) fail.

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bukowski-smoke-fed-samedir-'));
const PEERS_DIR = path.join(FAKE_HOME, '.bukowski', 'peers');

const CHILD_SCRIPT = `
'use strict';
const path = require('path');
const { PeerRegistry } = require('${ROOT.replace(/\\/g, '\\\\')}/src/federation/PeerRegistry');
const { FederationHub } = require('${ROOT.replace(/\\/g, '\\\\')}/src/federation/FederationHub');

const baseHost = process.env.MY_BASE_HOST;
const label = process.env.MY_LABEL;
const peersDir = path.join(process.env.HOME, '.bukowski', 'peers');

const reg = new PeerRegistry({
  peersDir,
  host: baseHost,
  sessionId: 'sess-' + label
});
const resolved = reg.start();

const localAgent = { id: 'claude-1', type: 'claude' };
const federatedId = 'claude-' + resolved + '-1';

const hub = new FederationHub({
  host: resolved,
  sessionId: 'sess-' + label,
  peerRegistry: reg,
  socketPath: '/tmp/bukowski-fed-samedir-' + label + '-' + process.pid + '.sock',
  getLocalRoster: () => [{ localId: localAgent.id, type: localAgent.type, federatedId }]
});

hub.on('forward', ({ payload }) => {
  const ipcMsg = payload.ipcMessage;
  process.stdout.write('FORWARDED ' + JSON.stringify({
    label,
    resolved,
    federatedId,
    wireTo: ipcMsg.to,
    fipaReceiver: ipcMsg.payload && ipcMsg.payload._fipaMessage && ipcMsg.payload._fipaMessage.receiver,
    body: ipcMsg.payload
  }) + '\\n');
});

(async () => {
  await hub.start();
  reg.update({ fedSocket: hub.socketPath });
  process.stdout.write('READY ' + JSON.stringify({ label, resolved, federatedId }) + '\\n');
})().catch((err) => {
  process.stderr.write('ERR ' + err.message + '\\n');
  process.exit(1);
});

process.on('SIGTERM', () => {
  try { hub.stop(); } catch {}
  try { reg.stop(); } catch {}
  process.exit(0);
});
setInterval(() => {}, 1000);
`;

const childPath = path.join(os.tmpdir(), 'bukowski-fed-samedir-child.js');
fs.writeFileSync(childPath, CHILD_SCRIPT);

function fail(msg, extra) {
  console.error('FAIL:', msg);
  if (extra) console.error(extra);
  process.exit(1);
}

function spawnNode(label, baseHost) {
  const p = cp.spawn('node', [childPath], {
    env: { ...process.env, HOME: FAKE_HOME, MY_BASE_HOST: baseHost, MY_LABEL: label },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  p.stdout.setEncoding('utf-8');
  p.stderr.setEncoding('utf-8');
  p.events = { ready: null, forwards: [] };
  p.buf = '';
  p.stdout.on('data', (chunk) => {
    p.buf += chunk;
    let idx;
    while ((idx = p.buf.indexOf('\n')) !== -1) {
      const line = p.buf.slice(0, idx);
      p.buf = p.buf.slice(idx + 1);
      if (line.startsWith('READY ')) {
        p.events.ready = JSON.parse(line.slice('READY '.length));
      } else if (line.startsWith('FORWARDED ')) {
        p.events.forwards.push(JSON.parse(line.slice('FORWARDED '.length)));
      }
    }
  });
  p.stderr.on('data', (chunk) => process.stderr.write(`[${label}!] ${chunk}`));
  return p;
}

async function waitForReady(p, label, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (p.events.ready) return p.events.ready;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms`);
}

(async () => {
  // Start A first so it locks in the unsuffixed "azra"; wait long enough
  // for its peer file to land before B looks.
  const A = spawnNode('A', 'azra');
  await waitForReady(A, 'A');
  const B = spawnNode('B', 'azra');
  await waitForReady(B, 'B');

  if (A.events.ready.resolved !== 'azra') {
    return fail(`A.resolved expected 'azra', got '${A.events.ready.resolved}'`);
  }
  if (B.events.ready.resolved === 'azra') {
    return fail('B should have suffixed (collision detection missed)');
  }
  if (!B.events.ready.resolved.startsWith('azra-')) {
    return fail(`B.resolved expected 'azra-<hash>', got '${B.events.ready.resolved}'`);
  }

  // Now stand up M in-process and let it federate.
  process.env.HOME = FAKE_HOME;
  const { PeerRegistry } = require(path.join(ROOT, 'src/federation/PeerRegistry'));
  const { FederationHub } = require(path.join(ROOT, 'src/federation/FederationHub'));

  const mReg = new PeerRegistry({
    peersDir: PEERS_DIR,
    host: 'meddaemon',
    sessionId: 'sess-M'
  });
  const mResolved = mReg.start();
  const mHub = new FederationHub({
    host: mResolved,
    sessionId: 'sess-M',
    peerRegistry: mReg,
    socketPath: `/tmp/bukowski-fed-samedir-M-${process.pid}.sock`,
    getLocalRoster: () => [{
      localId: 'claude-1',
      type: 'claude',
      federatedId: `claude-${mResolved}-1`
    }]
  });
  await mHub.start();
  mReg.update({ fedSocket: mHub.socketPath });

  // Allow time for A and B to dial M and exchange rosters.
  await new Promise(r => setTimeout(r, 1200));

  if (mHub.peers.size !== 2) {
    return fail(`M expected 2 connected peers, got ${mHub.peers.size}: [${Array.from(mHub.peers.keys()).join(', ')}]`);
  }
  const aFed = A.events.ready.federatedId;
  const bFed = B.events.ready.federatedId;
  if (!mHub.remoteAgents.has(aFed)) {
    return fail(`M.remoteAgents missing ${aFed}`);
  }
  if (!mHub.remoteAgents.has(bFed)) {
    return fail(`M.remoteAgents missing ${bFed}`);
  }
  if (aFed === bFed) {
    return fail(`A and B announced the same federatedId ${aFed}`);
  }

  // Forward to A's federatedId — should land on A only.
  mHub.forwardIpcMessage({
    id: 'to-A',
    from: 'claude-meddaemon-1',
    to: aFed,
    type: 'request',
    payload: { _fipa: true, hello: 'for A' }
  });
  // Forward to B's federatedId — should land on B only.
  mHub.forwardIpcMessage({
    id: 'to-B',
    from: 'claude-meddaemon-1',
    to: bFed,
    type: 'request',
    payload: { _fipa: true, hello: 'for B' }
  });

  await new Promise(r => setTimeout(r, 500));

  // A should have one forward; its body should be the "for A" one.
  if (A.events.forwards.length !== 1) {
    return fail(`A expected 1 forward, got ${A.events.forwards.length}: ${JSON.stringify(A.events.forwards)}`);
  }
  if (A.events.forwards[0].body.hello !== 'for A') {
    return fail(`A got wrong body: ${JSON.stringify(A.events.forwards[0])}`);
  }
  if (B.events.forwards.length !== 1) {
    return fail(`B expected 1 forward, got ${B.events.forwards.length}: ${JSON.stringify(B.events.forwards)}`);
  }
  if (B.events.forwards[0].body.hello !== 'for B') {
    return fail(`B got wrong body: ${JSON.stringify(B.events.forwards[0])}`);
  }

  console.log(`A.resolved=${A.events.ready.resolved} federatedId=${aFed}`);
  console.log(`B.resolved=${B.events.ready.resolved} federatedId=${bFed}`);
  console.log('M.peers:', Array.from(mHub.peers.keys()).join(', '));
  console.log('A correctly received its forward; B correctly received its forward');

  mHub.stop(); mReg.stop();
  A.kill('SIGTERM'); B.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 300));
  try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch {}
  try { fs.unlinkSync(childPath); } catch {}
  console.log('OK: same-dir federation smoke passed');
  process.exit(0);
})().catch((err) => {
  console.error('FAIL: unexpected error:', err);
  process.exit(1);
});
