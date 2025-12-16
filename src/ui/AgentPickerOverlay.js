// src/ui/AgentPickerOverlay.js - Agent selection list overlay
// Shows when hjkl direction has no pane, or for explicit agent selection

const {
  Overlay,
  BOX,
  RESET, DIM, BOLD, REVERSE,
  BG_DARK, BG_DARKER,
  FG_WHITE, FG_GRAY, FG_CYAN
} = require('./Overlay');

/**
 * AgentPickerOverlay
 *
 * Simple list overlay for selecting a target agent.
 * Used when directional targeting (hjkl) doesn't find a pane.
 *
 * Visual:
 * ┌─ Select Target Agent ──────────────┐
 * │ > claude-1 (Claude)                 │
 * │   codex-1 (Codex)                   │
 * │   gemini-1 (Gemini)                 │
 * └─ j/k:move Enter:select Esc:cancel ──┘
 */
class AgentPickerOverlay extends Overlay {
  constructor(config) {
    super({
      ...config,
      title: config.title || 'Select Target Agent',
      height: Math.min(config.agents?.length + 3 || 6, 12)
    });

    this.agents = config.agents || [];
    this.selectedIndex = 0;
    this.excludeAgent = config.excludeAgent || null;

    // Filter out excluded agent
    if (this.excludeAgent) {
      this.agents = this.agents.filter(a => a.id !== this.excludeAgent);
    }

    // Adjust height based on agent count
    this.bounds.height = Math.min(this.agents.length + 3, 12);
  }

  /**
   * Handle input for list navigation
   * @param {string} data
   * @returns {Object}
   */
  handleInput(data) {
    // j/down - next
    if (data === 'j' || data === '\x1b[B') {
      this.selectedIndex = (this.selectedIndex + 1) % this.agents.length;
      return { action: 'picker_move' };
    }

    // k/up - prev
    if (data === 'k' || data === '\x1b[A') {
      this.selectedIndex = this.selectedIndex <= 0
        ? this.agents.length - 1
        : this.selectedIndex - 1;
      return { action: 'picker_move' };
    }

    // Enter - select
    if (data === '\r' || data === '\n') {
      const selected = this.agents[this.selectedIndex];
      return {
        action: 'picker_select',
        agent: selected,
        agentId: selected?.id
      };
    }

    // ESC - cancel
    if (data === '\x1b') {
      return { action: 'picker_cancel' };
    }

    // Number keys 1-9 for quick select
    if (data >= '1' && data <= '9') {
      const idx = parseInt(data) - 1;
      if (idx < this.agents.length) {
        this.selectedIndex = idx;
        const selected = this.agents[idx];
        return {
          action: 'picker_select',
          agent: selected,
          agentId: selected?.id
        };
      }
    }

    return { action: 'noop' };
  }

  /**
   * Render the agent picker
   * @returns {Array}
   */
  render() {
    const lines = [];
    const { x, y, width, height } = this.bounds;

    // Header
    lines.push({
      row: y,
      col: x,
      content: this._renderHeader()
    });

    // Agent list
    const listHeight = height - 2;
    const scrollOffset = Math.max(0, this.selectedIndex - listHeight + 2);

    for (let i = 0; i < listHeight; i++) {
      const agentIdx = scrollOffset + i;
      lines.push({
        row: y + 1 + i,
        col: x,
        content: this._renderAgentLine(agentIdx)
      });
    }

    // Footer
    lines.push({
      row: y + height - 1,
      col: x,
      content: this._renderFooter()
    });

    return lines;
  }

  /**
   * Render header
   * @private
   */
  _renderHeader() {
    const width = this.bounds.width;
    const title = ` ${this.title} `;
    const padding = width - title.length - 2;

    return `${BG_DARK}${FG_WHITE}${BOX.TL}${BOX.H}${BOLD}${title}${RESET}${BG_DARK}${FG_WHITE}${BOX.H.repeat(Math.max(0, padding))}${BOX.TR}${RESET}`;
  }

  /**
   * Render an agent line
   * @private
   */
  _renderAgentLine(idx) {
    const width = this.bounds.width;
    const contentWidth = width - 4;

    if (idx >= this.agents.length) {
      // Empty line
      return `${BG_DARKER}${FG_WHITE}${BOX.V} ${' '.repeat(contentWidth)} ${BOX.V}${RESET}`;
    }

    const agent = this.agents[idx];
    const isSelected = idx === this.selectedIndex;

    const bg = isSelected ? '\x1b[48;5;240m' : BG_DARKER;
    const fg = isSelected ? '\x1b[97m' : FG_WHITE;
    const marker = isSelected ? '>' : ' ';
    const num = idx < 9 ? `${idx + 1}.` : '  ';

    // Format: "> 1. claude-1 (Claude)"
    const label = `${marker} ${num} ${agent.name || agent.id}`;
    const typeInfo = agent.type ? ` (${agent.type})` : '';
    const fullLabel = (label + typeInfo).slice(0, contentWidth).padEnd(contentWidth);

    return `${bg}${fg}${BOX.V} ${fullLabel} ${BOX.V}${RESET}`;
  }

  /**
   * Render footer
   * @private
   */
  _renderFooter() {
    const width = this.bounds.width;
    const hint = ' j/k:move 1-9:quick Enter:select ';
    const padding = width - hint.length - 2;

    return `${BG_DARK}${FG_GRAY}${BOX.BL}${BOX.H.repeat(Math.max(0, padding))}${hint}${BOX.BR}${RESET}`;
  }

  /**
   * Get selected agent
   * @returns {Object|null}
   */
  getSelected() {
    return this.agents[this.selectedIndex] || null;
  }
}

module.exports = { AgentPickerOverlay };
