#!/usr/bin/env node
/**
 * Releasing the mouse (<C-Space>m).
 *
 * While bukowski captures the mouse, the terminal's own selection is dead: a
 * drag scrolls a pane instead of selecting, so there is no way to copy with the
 * mouse at all — `y` yanks into bukowski's register, not the system clipboard.
 * The toggle hands drag-select back for as long as it is off.
 *
 * Two things here are easy to get wrong and are what this guards:
 *   - BUKOWSKI_NO_MOUSE=1 exists for clients that garble mouse escapes badly
 *     enough to drop the session (ConnectBot on Android). A toggle must never
 *     hand those clients the thing they switched off.
 *   - setup() also runs on SIGCONT. If it re-enabled unconditionally, resuming
 *     a suspended session would silently take the mouse back.
 *
 * Idea from frnhr's fork (frnhr/bukowski, Dec 2025), which bound a bare Ctrl+T.
 * Ours sits behind the C-Space prefix: a bare key would be stolen from every
 * wrapped TUI, and Claude Code's own Ctrl+T opens its todo panel.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { TerminalManager } = require(path.join(ROOT, 'src', 'core', 'TerminalManager'));
const { InputRouter } = require(path.join(ROOT, 'src', 'input', 'InputRouter'));
const { Compositor } = require(path.join(ROOT, 'src', 'core', 'Compositor'));

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}`); }
}

const ON = '\x1b[?1000h\x1b[?1006h';
const OFF = '\x1b[?1000l\x1b[?1006l';

/** Run fn with stdout captured, returning everything written. */
function captureStdout(fn) {
  const real = process.stdout.write;
  const out = [];
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  try { fn(); } finally { process.stdout.write = real; }
  return out.join('');
}

/** Drive the manager without letting its escapes reach the real terminal. */
function silently(fn) { captureStdout(fn); }

function newManager(noMouse = false) {
  if (noMouse) process.env.BUKOWSKI_NO_MOUSE = '1';
  else delete process.env.BUKOWSKI_NO_MOUSE;
  // Null discovery paths: cleanup() must not unlink anything real.
  return new TerminalManager(null, null);
}

console.log('1. taking and releasing the mouse');
let t = newManager();
ok(t.mouseCaptured === false, 'a fresh manager has not touched the terminal yet');
let wrote = captureStdout(() => t.setMouseCapture(true));
ok(wrote === ON, 'enabling writes exactly the SGR mouse pair');
ok(t.mouseCaptured === true, 'and records that we hold it');
wrote = captureStdout(() => t.setMouseCapture());
ok(wrote === OFF, 'a bare toggle releases it');
ok(t.mouseCaptured === false, 'and records the release');
wrote = captureStdout(() => t.setMouseCapture());
ok(wrote === ON, 'toggling again re-takes it');

console.log('2. a no-op writes nothing');
// Escapes are cheap but not free: a repeated toggle used to redraw the status
// bar and re-emit mode changes, and a terminal that mishandles them should see
// each one once.
t = newManager();
silently(() => t.setMouseCapture(true));
let res;
wrote = captureStdout(() => { res = t.setMouseCapture(true); });
ok(res.changed === false, 'setting the state it already has reports no change');
ok(wrote === '', 'and emits nothing');

console.log('3. a client that opted out never gets the mouse back');
t = newManager(true);
ok(t.mouseAllowed() === false, 'BUKOWSKI_NO_MOUSE=1 forbids capture');
wrote = captureStdout(() => { res = t.setMouseCapture(true); });
ok(res.changed === false && res.captured === false, 'enabling is refused');
ok(/NO_MOUSE/.test(res.reason || ''), 'with the reason named, not a silent no-op');
ok(wrote === '', 'and no escape reaches a terminal that cannot take it');
wrote = captureStdout(() => t.setup());
ok(!wrote.includes(ON), 'setup() does not enable it either');
ok(t.mouseCaptured === false, 'state stays released');

console.log('4. resuming a suspended session keeps the user\'s choice');
// setup() is the SIGCONT path (TerminalManager.registerSignalHandlers), so it
// must re-apply the WISH rather than a hardcoded "on".
t = newManager();
silently(() => { t.setMouseCapture(true); t.setMouseCapture(false); });  // user pressed C-Space m
wrote = captureStdout(() => t.setup());
ok(!wrote.includes(ON), 'SIGCONT does not re-take a mouse the user released');
ok(wrote.includes(OFF), 'it reasserts the released state instead');
ok(t.mouseCaptured === false, 'and the state survives the suspend');
// The opposite case must still work.
t = newManager();
silently(() => t.setMouseCapture(true));
wrote = captureStdout(() => t.setup());
ok(wrote.includes(ON), 'a session that held the mouse gets it back on resume');

console.log('5. exit always gives the terminal back');
t = newManager();
silently(() => t.setMouseCapture(true));
wrote = captureStdout(() => t.cleanup());
ok(wrote.includes(OFF), 'cleanup releases the mouse');
ok(t.mouseCaptured === false, 'and records it, so a later setup() is honest');
t = newManager();
silently(() => { t.setMouseCapture(true); t.setMouseCapture(false); });
wrote = captureStdout(() => t.cleanup());
ok(wrote.includes(OFF), 'releasing twice is harmless — exit must not depend on state');

console.log('6. the key is behind the prefix, not stolen from the pane');
const router = new InputRouter();
ok(router.handlePrefixCommand('m').action === 'mouse_toggle', '<C-Space>m toggles the mouse');
// A bare Ctrl+T must still reach the focused agent: Claude Code binds it to its
// own todo panel, and a multiplexer that eats it breaks the wrapped tool. Read
// from source rather than driven, so it covers every mode at once.
const routerSrc = require('fs').readFileSync(
  path.join(ROOT, 'src', 'input', 'InputRouter.js'), 'utf8');
ok(!routerSrc.includes('\\x14'), 'no mode in InputRouter claims a bare Ctrl+T');
ok(router.handlePrefixCommand('\x14').action === 'unknown_prefix',
  'and it is not a prefix binding either');

console.log('7. the status bar says when selection is available');
const stubLayout = {
  getFocusedAgent: () => null,
  getAllPanes: () => [],
  getFocusedPane: () => null,
  focusedPaneId: null,
  isZoomed: () => false,
};
const comp = new Compositor({ getAllAgents: () => [] }, stubLayout, null, null, null, null);
ok(comp.mouseCaptured === true, 'a compositor assumes we hold the mouse');
ok(!comp.renderStatusBar().includes('[SELECT]'), 'and shows no indicator while we do');
comp.mouseCaptured = false;
ok(comp.renderStatusBar().includes('[SELECT]'), '[SELECT] appears once the mouse is released');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('OK: mouse-capture smoke passed');
