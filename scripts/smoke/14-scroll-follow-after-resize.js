#!/usr/bin/env node
// Regression: a pane that ends up AT THE BOTTOM after a reflow must keep
// following new output.
//
// Repro that motivated this: <C-Space>ww (focus_next) while ZOOMED —
// focusHandlers calls onHandleResize(), which runs cacheScrollPositions() then
// restoreScrollPositions(). The newly focused pane GROWS, so maxScroll shrinks
// and the "preserve scroll position" clamp drops it exactly on the new bottom.
// followTail was then forced false, so the pane read BOT/100% while new agent
// output never scrolled into view.
//
// Pure/fast: drives the real Compositor.restoreScrollPositions() with stubs.

const path = require('path');
const mod = require(path.join(__dirname, '..', '..', 'src', 'core', 'Compositor'));
const Compositor = mod.Compositor || mod;

let failed = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${msg}`);
  if (!cond) failed++;
};

function restore({ contentHeight, paneHeight, cachedScrollY, cachedAtBottom }) {
  const c = Object.create(Compositor.prototype);
  c.scrollOffsets = new Map();
  c.followTail = new Map();
  c.resizeCache = new Map([['p1', { scrollY: cachedScrollY, atBottom: cachedAtBottom }]]);
  c.layoutManager = {
    findPane: (id) => (id === 'p1' ? { id: 'p1', agentId: 'a1', bounds: { height: paneHeight } } : null)
  };
  c.session = { getAgent: () => ({ getContentHeight: () => contentHeight }) };
  c.restoreScrollPositions();
  return {
    scroll: c.scrollOffsets.get('p1'),
    follow: c.followTail.get('p1'),
    maxScroll: Math.max(0, contentHeight - paneHeight)
  };
}

// 1. The bug: pane grew, clamp lands on the new bottom -> must follow again.
let r = restore({ contentHeight: 100, paneHeight: 10, cachedScrollY: 100, cachedAtBottom: false });
ok(r.scroll === r.maxScroll, `grown pane lands at bottom (${r.scroll}/${r.maxScroll})`);
ok(r.follow === true, 'followTail re-enabled when clamped to the bottom');

// 2. Genuinely scrolled up must stay unfollowed (no regression).
r = restore({ contentHeight: 300, paneHeight: 10, cachedScrollY: 50, cachedAtBottom: false });
ok(r.scroll === 50, 'mid-scrollback position preserved');
ok(r.follow === false, 'followTail stays false mid-scrollback');

// 3. Cached atBottom still pins to bottom and follows.
r = restore({ contentHeight: 200, paneHeight: 20, cachedScrollY: 999, cachedAtBottom: true });
ok(r.scroll === r.maxScroll && r.follow === true, 'cached atBottom pins to bottom and follows');

// 4. Content fits the pane (maxScroll === 0) counts as at-tail.
r = restore({ contentHeight: 5, paneHeight: 20, cachedScrollY: 0, cachedAtBottom: false });
ok(r.scroll === 0 && r.follow === true, 'follows when there is nothing to scroll');

// 5. Overshoot/negative clamps to 0 and still follows.
r = restore({ contentHeight: 5, paneHeight: 50, cachedScrollY: -10, cachedAtBottom: false });
ok(r.scroll === 0 && r.follow === true, 'negative scroll clamps to 0 and follows');

if (failed > 0) {
  console.log(`${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('scroll-follow-after-resize OK');
