// src/core/DashboardAgent.js - Project dashboard as a pseudo-agent pane
//
// A read-only, always-on board that tiles alongside agent panes (opened with
// `:split dashboard` / `:vsplit dashboard`). It is the persistent sibling of
// the transient Ctrl+Space d overlay: same DashboardStore, but it stays on
// screen while you work and shows more at once.
//
// Layout (single combined view, rendered to EXACTLY the pane height so the
// project list stays pinned while only the digest scrolls):
//
//   ─── Projects (N) ───────────────
//   > azra              curator claude-azra-1 · rev 12
//     meddaemon         curator claude-meddaemon-1 · rev 7
//     [election] scratch  curator ? · rev 2
//   ─── azra · digest ──────────────
//   # azra · <goal> · rev 12
//   ## roadmap … ## tasks … (scrollable)
//
// Keys (the pane is focused like any other; Ctrl+Space still drives the
// window manager): j/k pick project · ↑/↓ scroll digest · Space/b page ·
// g/G top/end · r refresh · Tab next project.
//
// Like ChatAgent it has no PTY; it implements the duck-typed pane interface
// (getLine/getLineText/getContentHeight/getCursorPosition/resize/write) the
// Compositor reads. It renders its own ANSI lines and never stores content —
// it reads pointers live from the store on each refresh.

const EventEmitter = require('events');

const DIM = '\x1b[90m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const SEL_BG = '\x1b[48;5;240m';
const SEL_FG = '\x1b[97m';
const AUTO_REFRESH_MS = 2500;

class DashboardAgent extends EventEmitter {
  constructor(store, opts = {}) {
    super();

    this.store = store || null;

    // Pane/agent interface
    this.id = opts.id || 'dashboard-1';
    this.name = 'Dashboard';
    this.type = 'dashboard';
    this.status = 'running';
    this.pty = null;             // No PTY — virtual pane
    this.needsFakeCursor = false; // We render no input cursor

    // View state
    this.selectedIndex = 0;
    this.digestScroll = 0;
    this.projects = [];
    this.digestLines = [];
    this.detailProjectId = null;
    this._lastRevSig = '';

    // Rendering
    this.lines = [];
    this.plainLines = [];
    this.width = 80;
    this.height = 24;

    this._refresh();
    this.startAutoRefresh();
  }

  // ───────────────────────────────────────────────────────────────────────
  // Data
  // ───────────────────────────────────────────────────────────────────────

  _loadProjects() {
    if (!this.store) { this.projects = []; return; }
    try { this.projects = this.store.listProjects().projects || []; }
    catch { this.projects = []; }
    if (this.selectedIndex >= this.projects.length) {
      this.selectedIndex = Math.max(0, this.projects.length - 1);
    }
  }

  _loadDigest() {
    const p = this.projects[this.selectedIndex];
    if (!p || !this.store) { this.digestLines = []; this.detailProjectId = null; return; }
    if (p.id === this.detailProjectId && this.digestLines.length) return; // unchanged selection
    try {
      const d = this.store.digest('user', { projectId: p.id });
      this.digestLines = String(d.digest || '').split('\n');
    } catch (err) {
      const m = /DASHBOARD_ERROR (\{.*\})/.exec(err.message || '');
      this.digestLines = ['(error: ' + (m ? JSON.parse(m[1]).message : err.message) + ')'];
    }
    this.detailProjectId = p.id;
    this.digestScroll = 0;
  }

  // A cheap signature of "did anything change on disk" — project ids + revs +
  // election flags. Used by the auto-refresh poll to avoid redrawing on every
  // tick (reloadAll already happened; we only re-render + emit when it moved).
  _revSignature() {
    return this.projects.map((p) => `${p.id}:${p.rev}:${p.election || ''}`).join('|');
  }

  _refresh() {
    this._loadProjects();
    this._loadDigest();
    this._render();
  }

  /** Re-read the store; redraw only if something actually changed. */
  refresh(force = false) {
    this._loadProjects();
    const sig = this._revSignature();
    const changed = sig !== this._lastRevSig;
    if (!force && !changed) return;
    this._lastRevSig = sig;
    // Disk moved (or forced) — drop the cached digest so it re-reads.
    this.detailProjectId = null;
    this._loadDigest();
    this._render();
    this.emit('data');
  }

  startAutoRefresh() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      try { this.refresh(); } catch { /* best effort */ }
    }, AUTO_REFRESH_MS);
    if (this._timer.unref) this._timer.unref();
  }

  destroy() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this.removeAllListeners();
  }

  // ───────────────────────────────────────────────────────────────────────
  // Rendering — produce EXACTLY this.height lines (list pinned, digest scrolls)
  // ───────────────────────────────────────────────────────────────────────

  _render() {
    this.lines = [];
    this.plainLines = [];

    if (!this.store) {
      this._push(`${DIM}(dashboard disabled — BUKOWSKI_NO_DASHBOARD=1)${RESET}`, '(dashboard disabled)');
      this._padTo(this.height);
      return;
    }

    const total = this.projects.length;
    // List section: header + up to listRows project rows. Cap so the digest
    // always keeps at least a few rows even with many projects.
    const maxListRows = Math.max(2, Math.min(10, Math.floor(this.height * 0.4)));
    const listRows = Math.min(total, maxListRows);

    this._renderRule(`Projects (${total})`);
    if (total === 0) {
      this._push(`${DIM}  (none — create with dashboard_create_project)${RESET}`, '  (none)');
    } else {
      const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(listRows / 2), total - listRows));
      for (let i = 0; i < listRows; i++) {
        const idx = start + i;
        const p = this.projects[idx];
        const sel = idx === this.selectedIndex;
        const flag = p.election ? '[election] ' : '';
        const text = `${sel ? '>' : ' '} ${flag}${p.id}`.padEnd(28).slice(0, 28)
          + ` curator ${p.curator || '?'} · rev ${p.rev}`;
        this._pushRow(text, sel);
      }
    }

    // Digest section fills the remainder.
    const sel = this.projects[this.selectedIndex];
    this._renderRule(sel ? `${sel.id} · digest` : 'digest');
    const used = this.lines.length;
    const digestRows = Math.max(0, this.height - used);
    const maxScroll = Math.max(0, this.digestLines.length - digestRows);
    if (this.digestScroll > maxScroll) this.digestScroll = maxScroll;
    for (let i = 0; i < digestRows; i++) {
      const line = this.digestLines[this.digestScroll + i];
      this._pushDigest(line === undefined ? '' : line);
    }
    this._maxScroll = maxScroll;
  }

  _renderRule(label) {
    const text = `─── ${label} `;
    const pad = Math.max(0, this.width - text.length);
    this._push(`${DIM}${text}${'─'.repeat(pad)}${RESET}`, text + '─'.repeat(pad));
  }

  _pushRow(text, selected) {
    const t = this._fit(text);
    if (selected) this._push(`${SEL_BG}${SEL_FG}${t}${RESET}`, t);
    else this._push(t, t);
  }

  _pushDigest(text) {
    const plain = String(text == null ? '' : text).replace(/\t/g, '  ');
    const t = this._fit(plain);
    // Tint structure lines (headers / bullets) for readability.
    let styled = t;
    if (/^#/.test(plain)) styled = `${CYAN}${t}${RESET}`;
    else if (/^\s*##/.test(plain)) styled = `${CYAN}${t}${RESET}`;
    else styled = t;
    this._push(styled, t);
  }

  _push(styled, plain) {
    this.lines.push(styled);
    this.plainLines.push(plain);
  }

  _padTo(n) {
    while (this.lines.length < n) this._push('', '');
  }

  _fit(text) {
    let t = String(text == null ? '' : text).replace(/\t/g, '  ');
    if (t.length > this.width) t = t.slice(0, this.width - 1) + '…';
    return t;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Pane interface
  // ───────────────────────────────────────────────────────────────────────

  getContentHeight() { return this.lines.length; }
  getLine(index) { return this.lines[index] || ''; }
  getLineText(index) { return this.plainLines[index] || ''; }
  getCursorPosition() { return { line: 0, col: 0 }; }

  resize(cols, rows) {
    this.width = Math.max(10, cols || this.width);
    this.height = Math.max(3, rows || this.height);
    this._render();
  }

  write(data) { this.handleInput(data); }

  // ───────────────────────────────────────────────────────────────────────
  // Navigation
  // ───────────────────────────────────────────────────────────────────────

  handleInput(data) {
    const n = this.projects.length;
    const page = Math.max(1, this.height - 4);

    // Project selection
    if (data === 'j' || data === '\t') { if (n) { this.selectedIndex = (this.selectedIndex + 1) % n; this._reselect(); } return; }
    if (data === 'k' || data === '\x1b[Z') { if (n) { this.selectedIndex = (this.selectedIndex - 1 + n) % n; this._reselect(); } return; }

    // Digest scroll
    if (data === '\x1b[B') { this.digestScroll = Math.min(this._maxScroll || 0, this.digestScroll + 1); return this._redraw(); }
    if (data === '\x1b[A') { this.digestScroll = Math.max(0, this.digestScroll - 1); return this._redraw(); }
    if (data === ' ' || data === '\x06') { this.digestScroll = Math.min(this._maxScroll || 0, this.digestScroll + page); return this._redraw(); }
    if (data === 'b' || data === '\x02') { this.digestScroll = Math.max(0, this.digestScroll - page); return this._redraw(); }
    if (data === 'g') { this.digestScroll = 0; return this._redraw(); }
    if (data === 'G') { this.digestScroll = this._maxScroll || 0; return this._redraw(); }

    // Manual refresh
    if (data === 'r') { this.refresh(true); return; }

    // Everything else (incl. lone ESC, q) is a no-op — closing/leaving the
    // pane is the window manager's job (Ctrl+Space), not ours.
  }

  _reselect() {
    this.detailProjectId = null; // force digest reload for new selection
    this.digestScroll = 0;
    this._loadDigest();
    this._redraw();
  }

  _redraw() {
    this._render();
    this.emit('data');
  }

  // ───────────────────────────────────────────────────────────────────────
  // Serialization (session save/restore)
  // ───────────────────────────────────────────────────────────────────────

  toJSON() {
    return { id: this.id, name: this.name, type: 'dashboard' };
  }

  static fromJSON(data, store) {
    return new DashboardAgent(store, { id: data.id });
  }
}

module.exports = { DashboardAgent };
