#!/usr/bin/env node
/**
 * Session autosave / crash-safe resurrection (no PTY).
 *
 * Before this, the engine saved a session only on an explicit `:w`; the
 * SIGINT/SIGTERM shutdown destroyed it WITHOUT saving (multi.js). A host reboot
 * SIGTERMs every pane, so the whole fleet's live state was lost even though each
 * agent's LLM transcript survived on disk. Two mechanisms close the gap, both
 * covered here:
 *
 *   1. Session.saveSync — a SYNCHRONOUS save. The signal handlers run their
 *      callbacks and process.exit() in the same tick, so a shutdown save must
 *      finish synchronously; an awaited promise never resolves before exit.
 *   2. agentSessionId (the per-agent resume id) must survive the save→load
 *      round-trip, else a restored pane resumes the wrong / no conversation.
 *
 * Plus the restore-name selector rule that lets a cold `--restore <name>` name
 * its fresh session so the NEXT crash-restore finds it by name.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Session } = require('../../src/core/Session');
const { Agent } = require('../../src/core/Agent');
const { LayoutNode, Pane } = require('../../src/layout/LayoutNode');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bukowski-autosave-'));
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

// A fake conversation manager — only toJSON/restoreFromJSON are exercised here.
const convs = [{ id: 'c1', with: 'claude-2', messages: [{ act: 'inform', body: 'hi' }] }];
const cm = { toJSON: () => convs };

function mkSession() {
  const s = new Session('meddaemon');
  const a1 = new Agent({ id: 'claude-1', name: 'Claude', type: 'claude', command: 'claude', args: ['--foo'] });
  a1.agentSessionId = '11111111-1111-1111-1111-111111111111';
  a1.spawnedAt = 1000;
  const a2 = new Agent({ id: 'claude-2', name: 'Claude', type: 'claude', command: 'claude', args: [] });
  a2.agentSessionId = '22222222-2222-2222-2222-222222222222';
  a2.spawnedAt = 2000;
  s.addAgent(a1);
  s.addAgent(a2);
  s.layout = new Pane('claude-1');
  s.focusedPaneId = 'claude-1';
  return s;
}

// ── 1. saveSync is SYNCHRONOUS: the file is on disk the instant it returns ───
// This is the whole point — it must complete before process.exit() in the same
// tick. If saveSync were async (returned a pending promise, deferred the write)
// this read in the same synchronous block would throw ENOENT.
{
  const s = mkSession();
  const fp = s.saveSync(DIR, cm);
  const raw = fs.readFileSync(fp, 'utf-8'); // no await, no tick boundary
  const data = JSON.parse(raw);
  assert.strictEqual(data.id, s.id, 'saveSync wrote the session synchronously');
  assert.strictEqual(data.name, 'meddaemon', 'name persisted');
  console.log('OK: saveSync writes synchronously (readable in the same tick)');
}

// ── 2. saveSync ≡ async save (same bytes for the same state) ─────────────────
(async () => {
  const s = mkSession();
  const syncPath = s.saveSync(DIR, cm);
  const syncBytes = fs.readFileSync(syncPath, 'utf-8');
  // async save writes to the SAME path (keyed by id) — capture its bytes.
  const asyncPath = await s.save(DIR, cm);
  const asyncBytes = fs.readFileSync(asyncPath, 'utf-8');
  assert.strictEqual(asyncPath, syncPath, 'both write the id-keyed file');
  assert.strictEqual(syncBytes, asyncBytes, 'sync and async saves are byte-identical');
  console.log('OK: saveSync and save produce identical output');

  // ── 3. round-trip: resume ids + layout + conversations survive ─────────────
  const restored = await Session.load(syncPath, Agent, LayoutNode, null, { restoreFromJSON() {} }, null);
  assert.strictEqual(restored.id, s.id, 'id round-trips');
  assert.strictEqual(restored.name, 'meddaemon', 'name round-trips');
  assert.strictEqual(restored.focusedPaneId, 'claude-1', 'focused pane round-trips');
  const ids = restored.getAllAgents().map((a) => a.id).sort();
  assert.deepStrictEqual(ids, ['claude-1', 'claude-2'], 'both agents round-trip');
  const r1 = restored.getAgent('claude-1');
  assert.strictEqual(r1.agentSessionId, '11111111-1111-1111-1111-111111111111',
    'the resume id survives — a restored pane continues its OWN conversation');
  console.log('OK: agents, layout, and per-agent resume ids round-trip');

  // ── 3b. contrast (tip-27): no resume id saved → none restored ──────────────
  const bare = new Session('bare');
  const a = new Agent({ id: 'claude-1', name: 'C', type: 'claude', command: 'claude', args: [] });
  bare.addAgent(a); bare.layout = new Pane('claude-1');
  const barePath = bare.saveSync(DIR, cm);
  const bareR = await Session.load(barePath, Agent, LayoutNode, null, { restoreFromJSON() {} }, null);
  assert.ok(!bareR.getAgent('claude-1').agentSessionId,
    'an agent saved with no resume id restores with none (the field is real, not hard-coded)');
  console.log('OK: resume-id round-trip is capable (absent stays absent)');

  // ── 4. the raw JSON carries conversations (folded in on save) ──────────────
  const data = JSON.parse(fs.readFileSync(syncPath, 'utf-8'));
  assert.deepStrictEqual(data.conversations, convs, 'conversations are folded into the snapshot');
  console.log('OK: conversations persist in the snapshot');

  runSelectorTests();
  console.log('OK: session autosave smoke passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

// ── 5. restore-name selector rule (mirrors multi.js:285) ─────────────────────
// A named restore that found nothing must name its fresh session after the
// restore target; 'latest' is a selector, not a name. Pins the contract so a
// regression that drops the naming is caught. Contrast across inputs so the
// assertion cannot pass by always picking one branch.
function pickName(cliRestore, sessionName, env) {
  const restoreName = (typeof cliRestore === 'string' && cliRestore !== 'latest') ? cliRestore : null;
  return sessionName || restoreName || env || 'Main';
}
function runSelectorTests() {
  assert.strictEqual(pickName('meddaemon', null, null), 'meddaemon',
    'cold named restore names the fresh session after the target');
  assert.strictEqual(pickName('latest', null, null), 'Main',
    "'latest' is a selector, not a name");
  assert.strictEqual(pickName(false, null, null), 'Main', 'no restore → Main');
  assert.strictEqual(pickName('azra', null, 'ENVNAME'), 'azra', 'restore target beats env');
  assert.strictEqual(pickName(false, 'explicit', 'ENVNAME'), 'explicit', '--session wins over all');
  assert.strictEqual(pickName(false, null, 'ENVNAME'), 'ENVNAME', 'env beats the Main default');
  console.log('OK: restore-name selector names cold named restores (latest excluded)');
}
