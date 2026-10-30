#!/usr/bin/env node
/**
 * One identity per codex agent (bug-28).
 *
 * codex's MCP bridge is spawned by a machine-global app-server-daemon, so it is
 * nowhere in its pane's process tree and cannot be matched to it. It therefore
 * got an external SEAT distinct from the pane it serves, and one agent had two
 * identities: mail to the pane woke it but truncated at 200 chars into a queue
 * nothing drains, mail to the seat carried the full text but raised no
 * notification at all. No single address both woke and delivered, the seat
 * number changed on every restart and daemon bounce, and a retired number
 * silently became another agent's pane alias.
 *
 * The fix hands the bridge its pane id on the command line, via codex's own
 * `-c` config override, so it declares that id at initialize and no seat is
 * minted.
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const { getPaneBindingArgs, createAgentTypes, MCP_BRIDGE_SCRIPT } = require(path.join(ROOT, 'src', 'bootstrap'));
const BRIDGE = path.join(ROOT, 'src', 'mcp', 'bukowski-mcp-bridge.js');

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = createAgentTypes('claude', '/opt/codex/bin/codex.js');

console.log('1. only the type that needs telling gets told');
delete process.env.BUKOWSKI_NO_PANE_BINDING;
ok(getPaneBindingArgs(TYPES, 'codex', 'codex-2').length === 4, 'codex gets the override');
ok(getPaneBindingArgs(TYPES, 'claude', 'claude-1').length === 0,
  'claude does not — its bridge is its own pane child and matches already');
ok(getPaneBindingArgs(TYPES, 'gemini', 'gemini-1').length === 0, 'gemini is untouched');
ok(getPaneBindingArgs(TYPES, 'codex', null).length === 0, 'no pane id, no claim');
ok(getPaneBindingArgs(null, 'codex', 'codex-1').length === 0, 'missing type table is a no-op');

console.log('2. the override is valid, complete, and names this pane');
const args = getPaneBindingArgs(TYPES, 'codex', 'codex-2');
ok(args[0] === '-c' && args[2] === '-c', 'passed as codex -c overrides');
ok(args[1] === 'mcp_servers.bukowski.command="node"',
  'command is set too — overriding args alone would leave a config with no command');
const payload = args[3];
ok(payload.startsWith('mcp_servers.bukowski.args='), 'and the server args');
const parsed = JSON.parse(payload.slice('mcp_servers.bukowski.args='.length));
ok(parsed[0] === MCP_BRIDGE_SCRIPT && fs.existsSync(parsed[0]), 'pointing at the real bridge script');
ok(parsed[1] === '--agent-id' && parsed[2] === 'codex-2', 'carrying THIS pane id');
// TOML array syntax is what codex parses the value as; JSON of a string array is valid TOML.
ok(/^\[".*"\]$/.test(payload.slice('mcp_servers.bukowski.args='.length)), 'the value is a TOML string array');

console.log('3. an operator can refuse it');
process.env.BUKOWSKI_NO_PANE_BINDING = '1';
ok(getPaneBindingArgs(TYPES, 'codex', 'codex-2').length === 0, 'BUKOWSKI_NO_PANE_BINDING=1 falls back to seats');
delete process.env.BUKOWSKI_NO_PANE_BINDING;

console.log('4. the bridge believes the argument over the environment');
// Deliberate precedence: an env var can be INHERITED by a pre-warmed process
// from another workspace (bug-22); the argument is written for one pane only.
async function bridgeIdentity({ argv, env }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bukowski-panebind-'));
  const sock = path.join(tmp, `bukowski-mcp-${process.pid}.sock`);
  let claimed = null;
  const server = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const l of lines) {
        if (!l.trim()) continue;
        const req = JSON.parse(l);
        if (req.method === 'initialize') {
          claimed = Object.prototype.hasOwnProperty.call(req.params, 'agentId')
            ? req.params.agentId : undefined;
          c.write(`${JSON.stringify({ jsonrpc:'2.0', id:req.id, result:{ assignedAgentId: claimed || 'codex-x-9' } })}\n`);
        }
      }
    });
    c.on('error', () => {});
  });
  await new Promise((r) => server.listen(sock, r));
  const br = spawn(process.execPath, [BRIDGE, ...argv], {
    cwd: tmp,
    env: { ...process.env, HOME: tmp, BUKOWSKI_MCP_SOCKET: sock, BUKOWSKI_BRIDGE_LOG: 'off', ...env },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  br.stdin.write(`${JSON.stringify({ jsonrpc:'2.0', id:1, method:'initialize', params:{} })}\n`);
  await sleep(900);
  br.kill('SIGTERM');
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  return claimed;
}

async function live() {
  ok(await bridgeIdentity({ argv: ['--agent-id', 'codex-2'], env: {} }) === 'codex-2',
    'the argument is declared at initialize, so no seat is minted');
  ok(await bridgeIdentity({ argv: ['--agent-id=codex-3'], env: {} }) === 'codex-3',
    '--agent-id=value form works too');
  ok(await bridgeIdentity({ argv: ['--agent-id', 'codex-2'], env: { BUKOWSKI_AGENT_ID: 'claude-9' } }) === 'codex-2',
    'the argument BEATS an inherited BUKOWSKI_AGENT_ID (bug-22)');
  ok(await bridgeIdentity({ argv: [], env: { BUKOWSKI_AGENT_ID: 'claude-9' } }) === 'claude-9',
    'without the argument the env still works, unchanged');
  const none = await bridgeIdentity({ argv: [], env: { BUKOWSKI_AGENT_ID: '' } });
  ok(none === null, 'with neither, it claims nothing and lets the server assign a seat');

  console.log('5. every spawn path binds, including the ones that bit us');
  // A restart or a respawn that forgot the binding would silently reintroduce
  // the two-identity split, so assert on the source of all three call sites.
  const multi = fs.readFileSync(path.join(ROOT, 'multi.js'), 'utf8');
  ok((multi.match(/getPaneBindingArgs\(/g) || []).length >= 3,
    'createNewAgent, session restore and respawn-without-resume all bind');
  const restore = multi.slice(multi.indexOf('const resumeArgs = typeConfig.getResumeArgs'));
  const combined = restore.slice(0, restore.indexOf('\n', restore.indexOf('const combinedArgs')));
  ok(/\.\.\.binding, \.\.\.resumeArgs/.test(combined),
    'and the override precedes `resume` — -c is a global option, not a subcommand flag');
}

live().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('OK: pane-binding smoke passed');
}).catch((e) => { console.log(`  FAIL ${e.stack}`); process.exit(1); });
