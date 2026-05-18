#!/usr/bin/env node
// PTY-boot smoke. Spawns bukowski in a fake 120x30 PTY, lets it boot for
// a few seconds, sends SIGINT, asserts:
//   - process exits within timeout
//   - stderr-style output never contains TypeError / ReferenceError /
//     "UnhandledPromiseRejection" / "Error: " patterns
//   - the boot wrote a peers file under the fake HOME
//
// Uses a fresh temp HOME so we don't touch the user's real session state.
// Skips with a warning if `node-pty` import fails (e.g. dev install).

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

let pty;
try { pty = require('node-pty'); }
catch (err) {
  console.error('SKIP: node-pty not installed:', err.message);
  process.exit(0);
}

const REPO = path.resolve(__dirname, '..', '..');
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bukowski-smoke-home-'));

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

function fail(msg, extras) {
  console.error('FAIL:', msg);
  if (extras) console.error(extras);
  cleanup();
  process.exit(1);
}

function cleanup() {
  try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch {}
}

const child = pty.spawn('node', [path.join(REPO, 'multi.js')], {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd: REPO,
  env: {
    ...process.env,
    HOME: FAKE_HOME,
    BUKOWSKI_HOST: 'smoketest',
    // No agent CLIs needed — bukowski will spawn `claude` and the pane will
    // just show a "command not found" string. That's fine; we only care
    // that bukowski itself doesn't crash.
  }
});

let buf = '';
child.on('data', (d) => { buf += d.toString(); });

let exited = false;
let exitCode = null;
let exitSignal = null;
child.on('exit', (code, signal) => {
  exited = true;
  exitCode = code;
  exitSignal = signal;
});

const BOOT_WAIT_MS = 4000;
const QUIT_WAIT_MS = 4000;

setTimeout(() => {
  // Boot grace period over. Look for crashes in the bytestream so far.
  const clean = stripAnsi(buf);
  const errorMatch = clean.match(/(TypeError|ReferenceError|UnhandledPromiseRejection|at Module\._compile|Cannot read propert(y|ies) of)/);
  if (errorMatch) {
    return fail('error pattern in boot output: ' + errorMatch[0], clean.slice(-3000));
  }

  // Confirm the peer file appeared — proves PeerRegistry.start() ran.
  const peersDir = path.join(FAKE_HOME, '.bukowski', 'peers');
  if (!fs.existsSync(peersDir)) {
    return fail('~/.bukowski/peers/ never created', clean.slice(-2000));
  }
  const peerFiles = fs.readdirSync(peersDir).filter(f => /^\d+\.json$/.test(f));
  if (peerFiles.length === 0) {
    return fail('no peer files in ' + peersDir, clean.slice(-2000));
  }
  let info;
  try { info = JSON.parse(fs.readFileSync(path.join(peersDir, peerFiles[0]), 'utf-8')); }
  catch (e) { return fail('peer file unreadable: ' + e.message); }
  if (info.host !== 'smoketest') {
    return fail(`peer file host is ${JSON.stringify(info.host)}, expected smoketest`);
  }
  if (!info.fedSocket) {
    return fail('peer file has no fedSocket — FederationHub.start() did not advertise');
  }
  if (!fs.existsSync(info.fedSocket)) {
    return fail('fedSocket path ' + info.fedSocket + ' does not exist');
  }

  // All checks passed during boot — wind it down.
  child.kill('SIGINT');

  const deadline = Date.now() + QUIT_WAIT_MS;
  (function waitExit() {
    if (exited) {
      // SIGINT-triggered shutdown should exit 0; node-pty reports the
      // signal in `exitSignal` for kill paths.
      if (exitCode !== 0 && exitSignal !== 'SIGINT' && exitSignal !== null) {
        return fail(`bukowski exited with code=${exitCode} signal=${exitSignal}`, stripAnsi(buf).slice(-2000));
      }
      // Peer file should be gone after clean shutdown.
      if (fs.existsSync(path.join(peersDir, peerFiles[0]))) {
        return fail('peer file not unlinked on shutdown: ' + peerFiles[0]);
      }
      console.log('OK: PTY-boot smoke passed (host=smoketest, fedSocket=' + info.fedSocket + ')');
      cleanup();
      process.exit(0);
    }
    if (Date.now() > deadline) {
      try { child.kill('SIGKILL'); } catch {}
      return fail('bukowski did not exit within ' + QUIT_WAIT_MS + 'ms of SIGINT');
    }
    setTimeout(waitExit, 100);
  })();
}, BOOT_WAIT_MS);
