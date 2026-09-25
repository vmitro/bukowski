#!/usr/bin/env node
// Regression: no key in the <C-Space> tables may be bound twice, and no key
// may return an action nobody consumes.
//
//   bug-9  `case 'S'` appeared twice in handlePrefixCommand — once for the ACL
//          request-send pair, once for save_session. A switch takes the first
//          match, so <C-Space>S had always sent an ACL request and the save
//          binding was dead code that read as a working feature. Nothing
//          failed: the dispatcher drops an action with no handler silently
//          (ActionDispatcher.dispatch, no fallback is ever installed), so a
//          key can promise anything and no-op forever.
//
// Two checks, both source-driven so a new binding is covered automatically:
//   1. duplicate case labels inside any one key table — always a failure;
//   2. bound actions nobody consumes — locked to the KNOWN_DEAD list below so
//      the existing backlog is explicit and any NEW dead key fails the suite.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { InputRouter } = require(path.join(ROOT, 'src', 'input', 'InputRouter'));
const { ActionDispatcher } = require(path.join(ROOT, 'src', 'handlers'));

let failed = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${msg}`);
  if (!cond) failed++;
};

// Actions that are bound to a key but reach no handler and no consumer.
// Filed as bug-14. Shrink this list as they are implemented or unbound —
// never grow it to silence a new failure.
const KNOWN_DEAD = new Set([
  'show_help', 'load_session',
  'rotate_layout', 'swap_pane', 'resize_width',
  'ipc_broadcast', 'ipc_connect', 'ipc_disconnect', 'ipc_log', 'ipc_send',
]);

// ── 1. No key table binds the same key twice ────────────────────────────────
const src = fs.readFileSync(path.join(ROOT, 'src', 'input', 'InputRouter.js'), 'utf8');
for (const method of ['handlePrefixCommand', 'handleLayoutCommand', 'handleIPCCommand']) {
  const start = src.indexOf(`  ${method}(`);
  ok(start !== -1, `${method} found in source`);
  if (start === -1) continue;
  const end = src.indexOf('\n  }\n', start);
  const body = src.slice(start, end === -1 ? undefined : end);
  const seen = new Map();
  const dupes = [];
  for (const m of body.matchAll(/^\s*case ('(?:[^'\\]|\\.)*'):/gm)) {
    if (seen.has(m[1])) dupes.push(m[1]);
    seen.set(m[1], true);
  }
  ok(dupes.length === 0, `${method} binds each key once${dupes.length ? ` (duplicated: ${dupes.join(', ')})` : ''}`);
}

// ── 2. Every bound action reaches a handler or a consumer ───────────────────
// Consumers live in two places: the ActionDispatcher registry, and multi.js,
// which matches a handful of overlay actions by string before dispatching.
const handled = new Set(Object.keys(new ActionDispatcher().handlers));
const multi = fs.readFileSync(path.join(ROOT, 'multi.js'), 'utf8');
// InputRouter consumes its own prefix actions as router state, not as work.
const ROUTER_STATE = new Set(['layout_prefix', 'ipc_prefix', 'mode_change', 'command_start', 'search_start']);
const consumed = (action) => handled.has(action)
  || ROUTER_STATE.has(action)
  || multi.includes(`'${action}'`);

const keys = [];
for (let c = 32; c < 127; c++) keys.push(String.fromCharCode(c));
keys.push('\x16');

const tables = {
  prefix: (r, k) => r.handlePrefixCommand(k),
  layout: (r, k) => r.handleLayoutCommand(k),
  ipc: (r, k) => r.handleIPCCommand(k),
};

const deadNow = new Set();
let boundCount = 0;
for (const [name, fn] of Object.entries(tables)) {
  for (const k of keys) {
    let res;
    try { res = fn(new InputRouter(), k); } catch { continue; }
    const action = res && res.action;
    if (!action || /^unknown/.test(action)) continue;
    boundCount++;
    if (!consumed(action)) deadNow.add(`${name}:${JSON.stringify(k)} -> ${action}`);
  }
}
ok(boundCount > 40, `probed the key tables (${boundCount} bindings)`);

const newlyDead = [...deadNow].filter((d) => !KNOWN_DEAD.has(d.split(' -> ')[1]));
ok(newlyDead.length === 0, `no NEW key binds an action nobody consumes${newlyDead.length ? `: ${newlyDead.join(', ')}` : ''}`);

// The allowlist must not outlive the backlog: a fixed action left in it would
// quietly weaken this test.
const stillDeadActions = new Set([...deadNow].map((d) => d.split(' -> ')[1]));
const staleAllowances = [...KNOWN_DEAD].filter((a) => !stillDeadActions.has(a));
ok(staleAllowances.length === 0,
  `KNOWN_DEAD carries no fixed actions${staleAllowances.length ? ` (now live, drop them: ${staleAllowances.join(', ')})` : ''}`);

// ── 3. The specific collision bug-9 was filed for ───────────────────────────
ok(new InputRouter().handlePrefixCommand('S').action === 'acl_send_start',
  '<C-Space>S resolves to the ACL request-send it has always performed');
ok(consumed('acl_send_start'), 'and that action has a consumer');

if (failed > 0) {
  console.log(`${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('keymap OK');
