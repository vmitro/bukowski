#!/usr/bin/env node
// Regression: the tab keys must act on what the tab bar shows.
//
//   bug-8  The tab bar renders session.getAllAgents() and highlights the one
//          in the focused pane (Compositor.renderTabBar). The keys that drive
//          it indexed PANES instead: <C-Space>N focused pane N, ] / [ cycled
//          panes. With more agents than panes — the normal case — every tab
//          key past the pane count was a silent no-op, and <C-Space>ww died
//          outright on a single-pane layout (cycleFocus returns on <2 panes).
//
// Pure/fast: drives the real LayoutManager and the real handlers with a stub
// session; no PTY, no terminal.

const path = require('path');
const { LayoutManager } = require(path.join(__dirname, '..', '..', 'src', 'layout', 'LayoutManager'));
const { splitHandlers } = require(path.join(__dirname, '..', '..', 'src', 'handlers', 'layout', 'splitHandlers'));
const { focusHandlers } = require(path.join(__dirname, '..', '..', 'src', 'handlers', 'layout', 'focusHandlers'));

let failed = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${msg}`);
  if (!cond) failed++;
};

// Four agents, because the interesting case is more agents than panes.
const AGENTS = ['claude-1', 'claude-2', 'claude-3', 'claude-4'];

function setup(paneAgents = ['claude-1']) {
  const session = { layout: null, getAllAgents: () => AGENTS.map((id) => ({ id, name: id })) };
  const lm = new LayoutManager(session);
  lm.initSinglePane(paneAgents[0]);
  for (const a of paneAgents.slice(1)) lm.splitVertical(a);
  lm.focusPane(lm.getAllPanes()[0].id);
  const ctx = { layoutManager: lm, session, onHandleResize: () => { ctx.resizes++; } };
  ctx.resizes = 0;
  return { lm, ctx };
}
const shown = (lm) => lm.getFocusedPane().agentId;

// ── 1. <C-Space>N reaches every agent, not just the first pane-count many ───
{
  const { lm, ctx } = setup();
  ok(lm.getAllPanes().length === 1, 'one pane, four agents');
  splitHandlers.switch_tab(ctx, { index: 2 });
  ok(shown(lm) === 'claude-3', 'tab 3 shows the third AGENT on the only pane');
  splitHandlers.switch_tab(ctx, { index: 0 });
  ok(shown(lm) === 'claude-1', 'tab 1 comes back');
  splitHandlers.switch_tab(ctx, { index: 9 });
  ok(shown(lm) === 'claude-1', 'an index past the agent list changes nothing');
}

// ── 2. ] / [ walk the agent list and wrap ───────────────────────────────────
{
  const { lm, ctx } = setup();
  splitHandlers.next_tab(ctx, {});
  ok(shown(lm) === 'claude-2', 'next_tab steps to the next agent');
  splitHandlers.prev_tab(ctx, {});
  splitHandlers.prev_tab(ctx, {});
  ok(shown(lm) === 'claude-4', 'prev_tab wraps past the start of the list');
  splitHandlers.next_tab(ctx, {});
  ok(shown(lm) === 'claude-1', 'next_tab wraps past the end');
}

// ── 3. An agent that already owns a pane is FOCUSED, never duplicated ───────
{
  const { lm, ctx } = setup(['claude-1', 'claude-2']);
  const [p1, p2] = lm.getAllPanes();
  splitHandlers.switch_tab(ctx, { index: 1 });
  ok(lm.focusedPaneId === p2.id, 'switching to an on-screen agent focuses its pane');
  ok(p1.agentId === 'claude-1' && p2.agentId === 'claude-2', 'neither pane was retargeted');
  splitHandlers.switch_tab(ctx, { index: 3 });
  ok(p2.agentId === 'claude-4' && p1.agentId === 'claude-1',
    'an off-screen agent retargets the FOCUSED pane only');
}

// ── 4. <C-Space>ww still cycles panes when there are panes to cycle ─────────
{
  const { lm, ctx } = setup(['claude-1', 'claude-2']);
  const [p1, p2] = lm.getAllPanes();
  focusHandlers.focus_next(ctx, {});
  ok(lm.focusedPaneId === p2.id, 'focus_next moves focus to the second pane');
  ok(p1.agentId === 'claude-1' && p2.agentId === 'claude-2', 'pane cycling retargets nothing');
  focusHandlers.focus_next(ctx, {});
  ok(lm.focusedPaneId === p1.id, 'focus_next wraps back to the first pane');
}

// ── 5. ...and falls through to agents when there is only one pane ──────────
{
  const { lm, ctx } = setup();
  focusHandlers.focus_next(ctx, {});
  ok(shown(lm) === 'claude-2', 'focus_next on a lone pane advances the agent instead of dying');
  focusHandlers.focus_prev(ctx, {});
  ok(shown(lm) === 'claude-1', 'focus_prev goes back');
}

// ── 6. Zoomed: the retarget must reach the REAL pane, not the zoom copy ────
{
  const { lm, ctx } = setup(['claude-1', 'claude-2']);
  lm.toggleZoom();
  ok(lm.isZoomed(), 'zoomed onto the first pane');
  const zoomedId = lm.focusedPaneId;
  splitHandlers.switch_tab(ctx, { index: 3 });
  ok(shown(lm) === 'claude-4', 'the zoomed pane shows the new agent');
  ok(ctx.resizes > 0, 'a zoomed tab switch asks for a re-layout');
  lm.toggleZoom();
  const real = lm.getAllPanes().find((p) => p.id === zoomedId);
  ok(real.agentId === 'claude-4', 'the change survives unzooming (written through to savedLayout)');
  ok(lm.getAllPanes().filter((p) => p.agentId === 'claude-4').length === 1,
    'unzooming leaves exactly one pane on that agent');
}

// ── 7. Zoomed: an agent that already owns a real pane re-zooms onto it ─────
{
  const { lm, ctx } = setup(['claude-1', 'claude-2']);
  const realIds = lm.getAllPanes().map((p) => p.id);
  lm.toggleZoom();
  splitHandlers.switch_tab(ctx, { index: 1 });
  ok(shown(lm) === 'claude-2', 'zoomed switch to an on-screen agent shows it');
  ok(lm.focusedPaneId === realIds[1], 're-zoomed onto that agent\'s own pane');
  lm.toggleZoom();
  ok(lm.getAllPanes().map((p) => p.agentId).join(',') === 'claude-1,claude-2',
    'no pane was duplicated onto the same agent');
}

if (failed > 0) {
  console.log(`${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('tab-keys OK');
