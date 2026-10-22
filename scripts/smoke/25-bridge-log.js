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

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await sleep(500);

  console.log('6. a bridge announces itself before it knows anything');
  ok(find('start').length === 1, 'start is logged once, at boot');
  ok(find('start')[0].includes(`cwd=${tmp}`), 'with the cwd that decides its binding');
  ok(find('start')[0].includes('role=tools'), 'and the role it is serving');

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

live().then(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('OK: bridge log smoke passed');
}).catch((err) => {
  console.log(`  FAIL live bridge: ${err.message}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
