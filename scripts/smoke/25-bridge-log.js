#!/usr/bin/env node
/**
 * Bridge observability: every lifecycle transition must leave a line behind.
 *
 * The class of bug this guards against is not a crash — it is a bridge that
 * looks healthy and is not. `tools/list` answers from a static array whether or
 * not the socket is up, so a client reports "bukowski: connected (38 tools)"
 * with a dead link, and the only symptom is a call that quietly returns a
 * diagnostics blob. Reconstructing such a session afterwards meant walking
 * /proc; it should mean one grep.
 *
 * So this exercises a REAL bridge process against a REAL unix socket: connect,
 * identify, list, then the server dies under it and we check the drop is
 * recorded with the identity it held and how long it held it.
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const {
  bridgeLog, formatEvent, formatValue, logFilePath, resetDirCache, DEFAULT_LOG, MAX_BYTES,
} = require('../../src/mcp/bridgeLog');

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}`); }
}

const BRIDGE = path.join(__dirname, '..', '..', 'src', 'mcp', 'bukowski-mcp-bridge.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bukowski-bridgelog-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('1. one event is one line');
const line = formatEvent('connect', { socket: '/tmp/a.sock', via: 'cwd' }, { pid: 7, now: new Date(0) });
ok(line === '1970-01-01T00:00:00.000Z [bridge] pid=7 event=connect socket=/tmp/a.sock via=cwd',
  'timestamp, pid and event lead, fields follow in order');
ok(!line.includes('\n'), 'never wraps (a wrapped event is half a grep hit)');
ok(formatEvent('x', { a: undefined, b: 1 }, { pid: 1 }).endsWith('b=1'),
  'unset fields are omitted, not printed as undefined');
ok(formatEvent('x', { a: null }, { pid: 1 }).endsWith('a=null'),
  'but an explicit null is kept — "asked and got nothing" is a fact');

console.log('2. values that would break the line are quoted');
ok(formatValue('/tmp/a b.sock') === '"/tmp/a b.sock"', 'spaces');
ok(formatValue('k=v') === '"k=v"', 'embedded separators');
ok(formatValue('plain') === 'plain', 'ordinary values stay bare');
ok(formatValue(0) === '0' && formatValue(false) === 'false', 'falsy scalars survive');

console.log('3. the file is opt-out, not opt-in');
// Default-on is deliberate: a bridge spawned by codex's app-server-daemon
// writes stderr into the daemon's log, which is where this class of bug went
// to die. The box-wide file is the only place the human can find it.
ok(logFilePath({}) === DEFAULT_LOG, 'unset env -> ~/.bukowski/bridge.log');
ok(logFilePath({ BUKOWSKI_BRIDGE_LOG: '' }) === DEFAULT_LOG, 'empty is unset');
ok(logFilePath({ BUKOWSKI_BRIDGE_LOG: '/x/y.log' }) === '/x/y.log', 'explicit path wins');
for (const off of ['off', 'OFF', '0', 'none', 'false']) {
  ok(logFilePath({ BUKOWSKI_BRIDGE_LOG: off }) === null, `${off} disables file logging`);
}

console.log('4. logging never costs the caller anything');
const logFile = path.join(tmp, 'sub', 'bridge.log');
const sink = { write() {} };
bridgeLog('probe', { n: 1 }, { file: logFile, stderr: sink, pid: 1 });
ok(fs.existsSync(logFile), "the log's directory is created");
bridgeLog('probe', { n: 2 }, { file: logFile, stderr: sink, pid: 1 });
ok(fs.readFileSync(logFile, 'utf-8').trim().split('\n').length === 2, 'appends, never truncates');
let threw = false;
resetDirCache();
try {
  bridgeLog('probe', {}, { file: path.join(tmp, 'nope', 'deeper', 'x.log'), stderr: sink, pid: 1 });
} catch { threw = true; }
ok(!threw, 'an unreachable log is swallowed — traffic matters more than telemetry');
threw = false;
try {
  bridgeLog('probe', {}, { file: null, stderr: { write() { throw new Error('EPIPE'); } }, pid: 1 });
} catch { threw = true; }
ok(!threw, 'a closed stderr is swallowed too');

// Regression guard with teeth: mkdirSync(..., {recursive: true}) does not fail
// on a procfs path, it SPINS. In the bridge that call sits on the boot path, so
// a mistyped BUKOWSKI_BRIDGE_LOG would wedge the process before it answered a
// single request. Run it in a child so a regression fails the suite instead of
// hanging it.
console.log('4b. a pathological log path cannot wedge the bridge');
let wedged = false;
try {
  execFileSync(process.execPath, ['-e', `
    const { bridgeLog } = require(${JSON.stringify(path.join(__dirname, '..', '..', 'src', 'mcp', 'bridgeLog'))});
    bridgeLog('probe', {}, { file: '/proc/definitely/not/writable', stderr: { write() {} } });
  `], { timeout: 5000, stdio: 'ignore' });
} catch (err) {
  wedged = err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM';
}
ok(!wedged, 'an unwritable directory under /proc returns instead of spinning (never mkdir -p)');
resetDirCache();

console.log('5. the file stays greppable without a cron job');
const big = path.join(tmp, 'big.log');
fs.writeFileSync(big, 'x'.repeat(MAX_BYTES + 1));
bridgeLog('probe', {}, { file: big, stderr: sink, pid: 1 });
ok(fs.existsSync(`${big}.1`), 'oversized log is rotated aside');
ok(fs.readFileSync(big, 'utf-8').includes('event=probe'), 'and the new line lands in a fresh file');
ok(fs.statSync(big).size < 1024, 'which starts small');

// ---------------------------------------------------------------------------
// Live bridge against a fake instance.
// ---------------------------------------------------------------------------

/**
 * Stand in for bukowski's MCPServer: answer `initialize` with an assigned id
 * and `tools/call` with anything. Enough for the bridge to complete its
 * handshake, which is all the log claims to record.
 */
function fakeInstance(socketPath, assignedAgentId) {
  const conns = new Set();
  const server = net.createServer((sock) => {
    conns.add(sock);
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const l of lines) {
        if (!l.trim()) continue;
        const req = JSON.parse(l);
        if (req.method === 'initialize') {
          sock.write(`${JSON.stringify({
            jsonrpc: '2.0', id: req.id, result: { assignedAgentId },
          })}\n`);
        } else {
          sock.write(`${JSON.stringify({
            jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'ok' }] },
          })}\n`);
        }
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => resolve({
      server,
      kill() { for (const c of conns) c.destroy(); server.close(); },
    }));
  });
}

async function live() {
  // Named for a pid that is running (our own) so socketIsLive accepts it: the
  // bridge refuses sockets left behind by dead instances, by design.
  const sockPath = path.join(tmp, `bukowski-mcp-${process.pid}.sock`);
  const liveLog = path.join(tmp, 'live.log');
  const inst = await fakeInstance(sockPath, 'codex-fake-1');

  const bridge = spawn(process.execPath, [BRIDGE], {
    cwd: tmp,
    env: {
      ...process.env,
      // Private HOME, so the bridge's own discovery (~/.bukowski/sockets, the
      // legacy socket file) sees an empty world. Without this its "most recent
      // active session" fallback reaches out and binds to a REAL instance on
      // the box the moment our fake one dies — which is correct behaviour and
      // useless for testing a dropped link.
      HOME: tmp,
      BUKOWSKI_MCP_SOCKET: sockPath,
      BUKOWSKI_BRIDGE_LOG: liveLog,
      BUKOWSKI_AGENT_ID: '',
      BUKOWSKI_AGENT_TYPE: 'codex',
      BUKOWSKI_BRIDGE_RECONNECT_MS: '300',
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const out = [];
  bridge.stdout.on('data', (d) => {
    for (const l of d.toString().split('\n')) if (l.trim()) out.push(JSON.parse(l));
  });
  const send = (o) => bridge.stdin.write(`${JSON.stringify(o)}\n`);
  const events = () => fs.readFileSync(liveLog, 'utf-8').trim().split('\n');
  const find = (name) => events().filter((l) => l.includes(` event=${name} `) || l.endsWith(` event=${name}`));

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'codex', version: '0.164.0', sessionId: 'c0ffee' },
      capabilities: {},
    },
  });
  await sleep(500);

  console.log('6. a bridge announces itself before it knows anything');
  ok(find('start').length === 1, 'start is logged once, at boot');
  ok(find('start')[0].includes(`cwd=${tmp}`), 'with the cwd that decides its binding');
  ok(find('start')[0].includes('role=tools'), 'and the role it is serving');

  console.log('6b. what the client said about itself is on the record');
  // A codex tools seat is renumbered on every daemon bounce because the only
  // handle for a stable seat is the bridge pid, and the daemon makes a new
  // bridge each time. A durable id would have to arrive here, so record what
  // is on offer rather than speculating about it.
  const ci = find('client-initialize');
  ok(ci.length === 1, 'the client initialize is logged');
  ok(ci[0].includes('client=codex') && ci[0].includes('clientVersion=0.164.0'),
    'with who is asking');
  ok(ci[0].includes('clientInfoKeys=name,version,sessionId'),
    'and the KEYS it offered — a session id shows up by name if it exists');
  ok(!ci[0].includes('c0ffee'), 'keys only: the values are the client\'s business');

  console.log('7. the binding is recorded, with the stage that chose it');
  ok(find('connect').length === 1, 'connect is logged');
  ok(find('connect')[0].includes(`socket=${sockPath}`), 'naming the socket actually dialled');
  ok(find('connect')[0].includes('via=env'), 'and which discovery stage won');
  ok(find('identify').length === 1, 'the assigned id is logged on handshake');
  ok(find('identify')[0].includes('agent=codex-fake-1'), 'as the instance assigned it');

  console.log('8. tools/list says what the client was handed');
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await sleep(300);
  const listed = find('tools-list');
  ok(listed.length === 1, 'every tools/list is logged — clients that cache ask exactly once');
  ok(/count=\d\d/.test(listed[0]), 'with the tool count the client cached');
  ok(listed[0].includes('connected=true'), 'and the link state at that moment');
  ok(listed[0].includes('agent=codex-fake-1'), 'and who it answered as');
  const listResp = out.find((r) => r.id === 2);
  ok(listResp?.result?.tools?.length > 0, 'the list itself is unchanged — an empty one poisons caches (tip-13)');

  console.log('9. the instance dies: the drop is on the record');
  inst.kill();
  await sleep(400);
  const drop = find('disconnect');
  ok(drop.length >= 1, 'disconnect is logged when the link breaks');
  ok(drop[0].includes('agent=codex-fake-1'), 'with the identity that was lost');
  ok(/heldForMs=\d+/.test(drop[0]), 'and how long it was held — a restart and a dead box differ only here');

  console.log('10. calls after the drop are marked degraded, not silent');
  send({
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_agents', arguments: {} },
  });
  await sleep(2200);   // ensureConnected's budget, then the diagnostics reply
  const degraded = find('degraded-call');
  ok(degraded.length === 1, 'the fallback to diagnostics is logged');
  ok(degraded[0].includes('tool=list_agents'), 'naming the tool the agent believed it had');
  const callResp = out.find((r) => r.id === 3);
  ok(callResp?.result?.isError === true, 'and the caller gets an error, not a plausible empty result');
  ok(/Last bound|Link lost/.test(callResp?.result?.content?.[0]?.text || ''),
    'diagnostics quote the lost link, so the agent can report the truth');

  console.log('11. a retry streak logs once, not every tick');
  // RECONNECT_INTERVAL_MS is 300ms here and we have waited several seconds.
  ok(find('connect-failed').length + find('no-socket').length <= 1,
    'a down instance does not flood the log (it is retried every few seconds forever)');

  console.log('12. being killed is distinguishable from losing the link');
  bridge.kill('SIGTERM');
  await sleep(300);
  ok(find('stop').length === 1, 'stop is logged on SIGTERM');
  ok(find('stop')[0].includes('signal=SIGTERM'), 'with the signal that did it');
}

/**
 * A bridge that loses its instance must wait for it, not adopt a stranger.
 *
 * Discovery's last resort is "the most recently touched instance on the box",
 * which is a reasonable guess for a REPL that never had a home and plainly
 * wrong for a bridge whose instance is merely restarting: it moves the agent
 * onto another project's roster under a name nobody is writing to. This is not
 * hypothetical — it happened in this very test file before the fix, when the
 * fake instance died and the bridge attached to a real bukowski on the box
 * within one reconnect tick.
 */
async function live2() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bukowski-bridgehome-'));
  const socksDir = path.join(home, '.bukowski', 'sockets');
  fs.mkdirSync(socksDir, { recursive: true });
  const instanceCwd = path.join(home, 'work');          // where the instance runs
  const bridgeCwd = path.join(home, 'outside');         // NOT inside it
  fs.mkdirSync(instanceCwd); fs.mkdirSync(bridgeCwd);
  const liveLog = path.join(home, 'live2.log');

  const sleepers = [];
  /** A pid that is really alive: discovery rejects sockets of dead pids. */
  function sleeper() {
    const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
    sleepers.push(c);
    return c.pid;
  }
  /** Publish an instance the way bukowski does: pid file, sidecar, socket. */
  async function publishInstance(cwd, agentId) {
    const pid = sleeper();
    const sockPath = path.join(home, `bukowski-mcp-${pid}.sock`);
    const inst = await fakeInstance(sockPath, agentId);
    fs.writeFileSync(path.join(socksDir, String(pid)), sockPath);
    fs.writeFileSync(path.join(socksDir, `${pid}.meta`), JSON.stringify({ socket: sockPath, pid, cwd }));
    return { pid, sockPath, inst };
  }

  const ours = await publishInstance(instanceCwd, 'codex-work-1');
  const stranger = await publishInstance(path.join(home, 'elsewhere'), 'codex-elsewhere-1');

  const bridge = spawn(process.execPath, [BRIDGE], {
    cwd: bridgeCwd,
    env: {
      ...process.env,
      HOME: home,
      // Bound by the env, like a bridge whose pane exported it — so our cwd is
      // not what found the instance, and cannot find it again.
      BUKOWSKI_MCP_SOCKET: ours.sockPath,
      BUKOWSKI_BRIDGE_LOG: liveLog,
      BUKOWSKI_AGENT_ID: '',
      BUKOWSKI_AGENT_TYPE: 'codex',
      BUKOWSKI_BRIDGE_RECONNECT_MS: '300',
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const send = (o) => bridge.stdin.write(`${JSON.stringify(o)}\n`);
  const events = () => fs.readFileSync(liveLog, 'utf-8').trim().split('\n');
  const find = (name) => events().filter((l) => l.includes(` event=${name} `) || l.endsWith(` event=${name}`));

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await sleep(500);

  console.log('13. the instance it reached is remembered by directory');
  ok(find('connect').length === 1, 'bound once, by the env it was given');
  ok(find('connect')[0].includes(`instanceCwd=${instanceCwd}`),
    "the instance's own directory is recorded — the one thing a restart preserves");

  console.log('14. its instance dies while another is live and listening');
  ours.inst.kill();
  try { fs.unlinkSync(ours.sockPath); } catch { /* node may have unlinked it */ }
  await sleep(1500);   // several reconnect ticks
  ok(find('disconnect').length === 1, 'the drop is recorded');
  ok(!find('connect').some((l) => l.includes(stranger.sockPath)),
    'it does NOT attach to the unrelated instance that is up');
  ok(find('home-down').length === 1, 'it says out loud that its own instance is down');
  ok(find('home-down')[0].includes(`instanceCwd=${instanceCwd}`), 'naming the instance it is waiting for');

  console.log('15. the instance comes back under a new pid; the bridge comes home');
  const replacement = await publishInstance(instanceCwd, 'codex-work-1');
  await sleep(1200);
  const back = find('connect').filter((l) => l.includes(replacement.sockPath));
  ok(back.length === 1, 'it reconnects to the replacement');
  ok(back[0].includes('via=sticky'), 'via the remembered directory, not a guess');
  ok(back[0].includes(`instance=${replacement.pid}`), 'which is a different process than before');
  ok(replacement.pid !== ours.pid, '(and really is a different pid)');

  bridge.kill('SIGTERM');
  await sleep(200);
  for (const c of sleepers) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  stranger.inst.kill();
  replacement.inst.kill();
  fs.rmSync(home, { recursive: true, force: true });
}

live().then(live2).then(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('OK: bridge log smoke passed');
}).catch((err) => {
  console.log(`  FAIL live bridge: ${err.message}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
