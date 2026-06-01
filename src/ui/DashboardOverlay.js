// src/ui/DashboardOverlay.js - Interactive project-dashboard overlay (Ctrl+Space d)
//
// Two views:
//   list   - the projects (j/k move, Enter/l drill in, r refresh, q/Esc close)
//   detail - the selected project's digest, scrollable (j/k scroll, Space page,
//            h/Esc back to list, q close)
//
// Reads live from the DashboardStore passed in config.store. Navigation mutates
// internal state and returns {action:'noop'} so the host's overlay-input loop
// just redraws; closing returns {action:'dashboard_close'}.

const {
  Overlay, BOX, RESET, DIM, BOLD,
  BG_DARK, BG_DARKER, FG_WHITE, FG_GRAY, FG_CYAN,
} = require('./Overlay');

const SELECTED_BG = '\x1b[48;5;240m';
const SELECTED_FG = '\x1b[97m';

class DashboardOverlay extends Overlay {
  constructor(config) {
    super({ ...config, title: 'Project Dashboard' });
    this.store = config.store;
    this.view = 'list';        // 'list' | 'detail'
    this.selectedIndex = 0;
    this.scroll = 0;
    this.projects = [];
    this.detailLines = [];
    this.detailProjectId = null;
    this._loadProjects();
  }

  _loadProjects() {
    try { this.projects = this.store.listProjects().projects || []; }
    catch { this.projects = []; }
    if (this.selectedIndex >= this.projects.length) this.selectedIndex = Math.max(0, this.projects.length - 1);
  }

  _loadDetail(projectId) {
    try {
      const d = this.store.digest('user', { projectId });
      this.detailLines = String(d.digest || '').split('\n');
    } catch (err) {
      const m = /DASHBOARD_ERROR (\{.*\})/.exec(err.message || '');
      this.detailLines = ['(error loading digest: ' + (m ? JSON.parse(m[1]).message : err.message) + ')'];
    }
    this.detailProjectId = projectId;
    this.scroll = 0;
  }

  _bodyRows() { return Math.max(1, this.bounds.height - 2); }
  _maxScroll() { return Math.max(0, this.detailLines.length - this._bodyRows()); }

  handleInput(data) {
    if (this.view === 'list') return this._handleList(data);
    return this._handleDetail(data);
  }

  _handleList(data) {
    const n = this.projects.length;
    if (data === 'j' || data === '\x1b[B') { if (n) this.selectedIndex = (this.selectedIndex + 1) % n; return { action: 'noop' }; }
    if (data === 'k' || data === '\x1b[A') { if (n) this.selectedIndex = (this.selectedIndex - 1 + n) % n; return { action: 'noop' }; }
    if (data === '\r' || data === '\n' || data === 'l' || data === '\x1b[C') {
      if (n) { this._loadDetail(this.projects[this.selectedIndex].id); this.view = 'detail'; }
      return { action: 'noop' };
    }
    if (data === 'r') { this._loadProjects(); return { action: 'noop' }; }
    if (data === '\x1b' || data === 'q') return { action: 'dashboard_close' };
    return { action: 'noop' };
  }

  _handleDetail(data) {
    const page = this._bodyRows();
    if (data === 'j' || data === '\x1b[B') { this.scroll = Math.min(this._maxScroll(), this.scroll + 1); return { action: 'noop' }; }
    if (data === 'k' || data === '\x1b[A') { this.scroll = Math.max(0, this.scroll - 1); return { action: 'noop' }; }
    if (data === ' ' || data === '\x06') { this.scroll = Math.min(this._maxScroll(), this.scroll + page); return { action: 'noop' }; }
    if (data === '\x02') { this.scroll = Math.max(0, this.scroll - page); return { action: 'noop' }; }
    if (data === 'g') { this.scroll = 0; return { action: 'noop' }; }
    if (data === 'G') { this.scroll = this._maxScroll(); return { action: 'noop' }; }
    if (data === 'r') { this._loadDetail(this.detailProjectId); return { action: 'noop' }; }
    if (data === 'h' || data === '\x7f' || data === '\x1b' || data === '\x1b[D') { this.view = 'list'; return { action: 'noop' }; }
    if (data === 'q') return { action: 'dashboard_close' };
    return { action: 'noop' };
  }

  render() {
    const { x, y, height } = this.bounds;
    const lines = [{ row: y, col: x, content: this._header() }];
    const rows = this._bodyRows();
    const body = this.view === 'list' ? this._listBody(rows) : this._detailBody(rows);
    for (let i = 0; i < rows; i++) {
      lines.push({ row: y + 1 + i, col: x, content: body[i] !== undefined ? body[i] : this._row('', false) });
    }
    lines.push({ row: y + height - 1, col: x, content: this._footer() });
    return lines;
  }

  _listBody(rows) {
    if (!this.projects.length) return [this._row('(no projects — create one with dashboard_create_project)', false)];
    // keep the selected row visible
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(rows / 2), Math.max(0, this.projects.length - rows)));
    const out = [];
    for (let i = 0; i < rows; i++) {
      const idx = start + i;
      if (idx >= this.projects.length) break;
      const p = this.projects[idx];
      const sel = idx === this.selectedIndex;
      // Election marker leads the line so it survives truncation of long names.
      const flag = p.election ? '[election] ' : '';
      const text = `${sel ? '>' : ' '} ${flag}${p.id} — curator ${p.curator || '?'} · rev ${p.rev}`;
      out.push(this._row(text, sel));
    }
    return out;
  }

  _detailBody(rows) {
    const out = [];
    for (let i = 0; i < rows; i++) {
      const line = this.detailLines[this.scroll + i];
      out.push(this._row(line === undefined ? '' : line, false));
    }
    return out;
  }

  _row(text, selected) {
    const cw = this.bounds.width - 4;
    let t = String(text == null ? '' : text).replace(/\t/g, '  ');
    if (t.length > cw) t = t.slice(0, cw - 1) + '…';
    t = t.padEnd(cw);
    const bg = selected ? SELECTED_BG : BG_DARKER;
    const fg = selected ? SELECTED_FG : FG_WHITE;
    return `${bg}${fg}${BOX.V} ${t} ${BOX.V}${RESET}`;
  }

  _header() {
    const width = this.bounds.width;
    const label = this.view === 'detail' && this.detailProjectId
      ? `dashboard · ${this.detailProjectId}`
      : 'Project Dashboard';
    const title = ` ${label} `;
    const pad = width - title.length - 2;
    return `${BG_DARK}${FG_CYAN}${BOX.TL}${BOX.H}${BOLD}${title}${RESET}${BG_DARK}${FG_CYAN}${BOX.H.repeat(Math.max(0, pad))}${BOX.TR}${RESET}`;
  }

  _footer() {
    const width = this.bounds.width;
    const hint = this.view === 'list'
      ? ' j/k:move  Enter:open  r:refresh  q/Esc:close '
      : ' j/k:scroll  Space:page  g/G:top/end  h/Esc:back  q:close ';
    const pad = width - hint.length - 2;
    return `${BG_DARK}${FG_GRAY}${BOX.BL}${BOX.H.repeat(Math.max(0, pad))}${hint}${BOX.BR}${RESET}`;
  }
}

module.exports = { DashboardOverlay };
