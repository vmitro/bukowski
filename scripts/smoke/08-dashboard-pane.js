#!/usr/bin/env node
// Dashboard pane smoke (no PTY). Proves the DashboardAgent — the always-on
// `:split dashboard` board — renders and navigates correctly against a real
// DashboardStore:
//   1. Renders EXACTLY the pane height (list pinned, digest fills remainder).
//   2. Shows the project list with the selected row marked + the selected
//      project's live digest (entries + refs, no bodies).
//   3. j/k move the selection and swap the digest; scroll keys clamp safely.
//   4. toJSON/fromJSON round-trips (id/type) for session save/restore.
//   5. A null store (BUKOWSKI_NO_DASHBOARD=1) degrades to a "disabled" board
//      that still fills its bounds rather than throwing.
//
// Pass: all assertions hold. Fail: throws / exits 1.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DashboardStore } = require('../../src/dashboard/DashboardStore');
const { DashboardAgent } = require('../../src/core/DashboardAgent');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bukowski-dashpane-'));
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

const CUR = 'claude-bukowski-1';
const AZRA = 'claude-azra-1';
const store = new DashboardStore({ root: ROOT });
let ts = 1;
store.createProject(AZRA, { name: 'Azra', goal: 'ship the app', repos: [{ repo: 'azra', root: '/tmp/azra' }] }, { ts: ts++ });
store.createProject(CUR, { name: 'Judge', goal: 'openai as a judge', repos: [{ repo: 'azra', root: '/tmp/azra' }] }, { ts: ts++ });
store.setEntry(AZRA, { projectId: 'azra', repo: 'azra', category: 'tasks', oneliner: 'wire device upload', refs: ['azra://sha/abc123'] }, { ts: ts++ });
store.setEntry(AZRA, { projectId: 'azra', repo: 'azra', category: 'bugs', oneliner: 'crash on rotate', refs: ['azra://sha/def456'] }, { ts: ts++ });

const a = new DashboardAgent(store, { id: 'dashboard-1' });
a.destroy(); // stop the auto-refresh timer; we drive refresh manually here
a.resize(70, 20);

const plain = () => a.plainLines.join('\n');

// 1 + 2: exact-height render, list + selected digest
assert.strictEqual(a.getContentHeight(), 20, 'renders exactly the pane height');
assert.ok(plain().includes('Projects (2)'), 'shows project count');
assert.ok(/^>/.test(a.plainLines[1]), 'first project is marked selected');
assert.ok(plain().includes('azra · digest'), 'digest header names the selected project');
assert.ok(plain().includes('wire device upload') && plain().includes('azra://sha/abc123'),
  'digest shows the selected project entry with its grounding ref');
console.log('OK: renders list + selected digest at exact pane height');

// 3: navigation swaps the digest
a.handleInput('j');
assert.strictEqual(a.detailProjectId, 'judge', 'j moves selection to the next project');
assert.ok(a.plainLines.join('\n').includes('judge · digest'), 'digest follows the selection');
a.handleInput('k');
assert.strictEqual(a.detailProjectId, 'azra', 'k moves selection back');
// scroll keys must clamp without throwing
a.handleInput(' '); a.handleInput('G'); a.handleInput('g'); a.handleInput('\x1b[B'); a.handleInput('\x1b[A');
assert.strictEqual(a.digestScroll, 0, 'scroll clamps back to top');
console.log('OK: j/k swap selection; scroll keys clamp safely');

// 4: serialization round-trip
assert.deepStrictEqual(a.toJSON(), { id: 'dashboard-1', name: 'Dashboard', type: 'dashboard' });
const restored = DashboardAgent.fromJSON(a.toJSON(), store);
restored.destroy();
assert.strictEqual(restored.id, 'dashboard-1', 'fromJSON preserves the pane id');
console.log('OK: toJSON/fromJSON round-trips for session restore');

// 5: disabled-store degradation
const off = new DashboardAgent(null, { id: 'dashboard-2' });
off.destroy();
off.resize(40, 6);
assert.ok(off.plainLines.join('\n').includes('disabled'), 'null store renders a disabled board');
assert.strictEqual(off.getContentHeight(), 6, 'disabled board still fills its bounds');
console.log('OK: null store degrades to a disabled board without throwing');

console.log('OK: dashboard-pane smoke passed');
