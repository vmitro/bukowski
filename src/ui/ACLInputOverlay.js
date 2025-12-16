// src/ui/ACLInputOverlay.js - FIPA ACL message input overlay
// Modal for composing and sending structured agent messages

const {
  Overlay,
  BOX,
  RESET, DIM, BOLD, REVERSE,
  BG_DARK, BG_DARKER,
  FG_WHITE, FG_GRAY, FG_CYAN
} = require('./Overlay');

// Performative colors
const PERF_COLORS = {
  'request':    '\x1b[36m',   // cyan
  'inform':     '\x1b[37m',   // white
  'query-if':   '\x1b[33m',   // yellow
  'query-ref':  '\x1b[33m',   // yellow
  'cfp':        '\x1b[35m',   // magenta
  'propose':    '\x1b[34m',   // blue
  'agree':      '\x1b[32m',   // green
  'refuse':     '\x1b[31m',   // red
  'subscribe':  '\x1b[36m',   // cyan
  'failure':    '\x1b[31m',   // red
};

// All available performatives (in cycle order)
const PERFORMATIVES = [
  'inform', 'request', 'query-if', 'query-ref',
  'cfp', 'propose', 'agree', 'refuse', 'subscribe'
];

/**
 * ACLInputOverlay
 *
 * Specialized overlay for composing FIPA ACL messages.
 * Shows performative, source/target agents, and message content.
 *
 * Visual:
 * ┌─ [REQUEST] from: claude-1 to: codex-1 ─────┐
 * │ Review this code section and suggest      │
 * │ improvements for performance...           │
 * │                                           │
 * └─ hjkl:target Tab:cycle Ctrl+P:perf Enter:send ─┘
 */
class ACLInputOverlay extends Overlay {
  constructor(config) {
    super(config);

    // ACL-specific state
    this.performative = config.performative || 'inform';
    this.sourceAgent = config.sourceAgent || null;
    this.targetAgent = config.targetAgent || null;

    // Agent list for picker mode
    this.agentList = config.agents || [];
    this.agentPickerActive = false;
    this.agentPickerIndex = 0;
  }

  /**
   * Set the target agent
   * @param {string} agentId
   */
  setTarget(agentId) {
    this.targetAgent = agentId;
    this.agentPickerActive = false;
    this.emit('target:changed', agentId);
  }

  /**
   * Cycle to next performative
   */
  cyclePerformative() {
    const idx = PERFORMATIVES.indexOf(this.performative);
    this.performative = PERFORMATIVES[(idx + 1) % PERFORMATIVES.length];
    this.emit('performative:changed', this.performative);
  }

  /**
   * Set performative directly
   * @param {string} perf
   */
  setPerformative(perf) {
    if (PERFORMATIVES.includes(perf)) {
      this.performative = perf;
      this.emit('performative:changed', this.performative);
    }
  }

  /**
   * Show agent picker list
   * @param {Array} agents - Array of { id, name, type }
   */
  showAgentPicker(agents) {
    this.agentList = agents.filter(a => a.id !== this.sourceAgent);
    this.agentPickerActive = true;
    this.agentPickerIndex = 0;

    // Find current target in list
    const idx = this.agentList.findIndex(a => a.id === this.targetAgent);
    if (idx >= 0) {
      this.agentPickerIndex = idx;
    }
  }

  /**
   * Hide agent picker
   */
  hideAgentPicker() {
    this.agentPickerActive = false;
  }

  /**
   * Handle input with ACL-specific keys
   * @param {string} data
   * @returns {Object}
   */
  handleInput(data) {
    // Agent picker mode
    if (this.agentPickerActive) {
      return this._handleAgentPickerInput(data);
    }

    // Tab - cycle agent / show picker
    if (data === '\t') {
      if (this.agentList.length > 0) {
        this.agentPickerIndex = (this.agentPickerIndex + 1) % this.agentList.length;
        this.targetAgent = this.agentList[this.agentPickerIndex]?.id;
        return { action: 'acl_target_cycle' };
      }
      return { action: 'acl_show_picker' };
    }

    // Ctrl+P - cycle performative
    if (data === '\x10') {
      this.cyclePerformative();
      return { action: 'acl_performative_cycle', performative: this.performative };
    }

    // hjkl in ACL mode - target direction
    if (data === 'h') return { action: 'acl_target_direction', dir: 'left' };
    if (data === 'j') return { action: 'acl_target_direction', dir: 'down' };
    if (data === 'k') return { action: 'acl_target_direction', dir: 'up' };
    if (data === 'l') return { action: 'acl_target_direction', dir: 'right' };

    // Enter - submit
    if (data === '\r' || data === '\n') {
      if (!this.targetAgent) {
        return { action: 'acl_need_target' };
      }
      return {
        action: 'acl_send',
        performative: this.performative,
        from: this.sourceAgent,
        to: this.targetAgent,
        content: this.inputBuffer
      };
    }

    // ESC - cancel
    if (data === '\x1b') {
      return { action: 'acl_cancel' };
    }

    // Delegate to base class for text editing
    return super.handleInput(data);
  }

  /**
   * Handle input in agent picker mode
   * @private
   */
  _handleAgentPickerInput(data) {
    // j/down - next agent
    if (data === 'j' || data === '\x1b[B') {
      this.agentPickerIndex = (this.agentPickerIndex + 1) % this.agentList.length;
      return { action: 'acl_picker_move' };
    }

    // k/up - prev agent
    if (data === 'k' || data === '\x1b[A') {
      this.agentPickerIndex = this.agentPickerIndex <= 0
        ? this.agentList.length - 1
        : this.agentPickerIndex - 1;
      return { action: 'acl_picker_move' };
    }

    // Enter - select agent
    if (data === '\r' || data === '\n') {
      const selected = this.agentList[this.agentPickerIndex];
      if (selected) {
        this.setTarget(selected.id);
      }
      return { action: 'acl_picker_select', agent: selected };
    }

    // ESC - cancel picker
    if (data === '\x1b') {
      this.agentPickerActive = false;
      return { action: 'acl_picker_cancel' };
    }

    return { action: 'noop' };
  }

  /**
   * Render the ACL overlay
   * @returns {Array}
   */
  render() {
    const lines = this._renderBase();

    if (this.agentPickerActive) {
      this._addPickerLines(lines);
    }

    return lines;
  }

  /**
   * Render base overlay (without picker)
   * @private
   */
  _renderBase() {
    const lines = [];
    const { x, y, width, height } = this.bounds;

    // Header - ensure exact width
    lines.push({
      row: y,
      col: x,
      content: this._ensureLineWidth(this._renderHeader(), width)
    });

    // Content lines - ensure exact width
    const visibleLines = this.getContentHeight();
    for (let i = 0; i < visibleLines; i++) {
      const lineIdx = this.scrollOffset + i;
      lines.push({
        row: y + 1 + i,
        col: x,
        content: this._ensureLineWidth(this._renderContentLine(lineIdx, i === visibleLines - 1), width)
      });
    }

    // Footer - ensure exact width
    lines.push({
      row: y + height - 1,
      col: x,
      content: this._ensureLineWidth(this._renderFooter(), width)
    });

    return lines;
  }

  /**
   * Add picker dropdown lines to existing render output
   * @private
   */
  _addPickerLines(lines) {
    // Add picker overlay below header
    const pickerX = this.bounds.x + 2;
    const pickerY = this.bounds.y + 1;
    const pickerWidth = Math.min(30, this.bounds.width - 4);
    const contentWidth = pickerWidth - 2; // Minus 2 for borders

    for (let i = 0; i < this.agentList.length && i < 6; i++) {
      const agent = this.agentList[i];
      const isSelected = i === this.agentPickerIndex;
      const bg = isSelected ? '\x1b[48;5;240m' : '\x1b[48;5;238m';
      const fg = isSelected ? '\x1b[97m' : '\x1b[37m';
      const marker = isSelected ? '>' : ' ';

      // Build label and ensure exact width
      const rawLabel = `${marker} ${agent.name} (${agent.type})`;
      const label = rawLabel.padEnd(contentWidth, ' ').substring(0, contentWidth);

      lines.push({
        row: pickerY + i,
        col: pickerX,
        content: `${bg}${fg}${BOX.V}${label}${BOX.V}${RESET}`
      });
    }
  }

  /**
   * Render ACL-specific header
   * @private
   */
  _renderHeader() {
    const width = this.bounds.width;
    const perfColor = PERF_COLORS[this.performative] || FG_WHITE;

    // [PERFORMATIVE] from: source to: target
    const perfLabel = `[${this.performative.toUpperCase()}]`;
    const fromLabel = this.sourceAgent ? ` from:${this.sourceAgent}` : '';
    const toLabel = this.targetAgent
      ? ` to:${this.targetAgent}`
      : ` to:<Tab>`;

    // Build title without ANSI first to calculate width
    const titleText = `${perfLabel}${fromLabel}${toLabel}`;
    // Available space for title: width - TL(1) - H(1) - space(1) - space(1) - TR(1) = width - 5
    // But we need some padding too, so truncate title if needed
    const maxTitleLen = width - 7;  // Leave room for at least 2 H chars of padding
    const truncatedTitle = titleText.length > maxTitleLen
      ? titleText.substring(0, maxTitleLen - 2) + '..'
      : titleText;

    // Now build with colors
    const coloredTitle = `${perfColor}${truncatedTitle.substring(0, perfLabel.length)}${RESET}${BG_DARK}${FG_WHITE}${truncatedTitle.substring(perfLabel.length)}`;

    const titleLen = truncatedTitle.length;
    const padding = width - titleLen - 5;

    return `${BG_DARK}${FG_WHITE}${BOX.TL}${BOX.H} ${coloredTitle} ${BOX.H.repeat(Math.max(0, padding))}${BOX.TR}${RESET}`;
  }

  /**
   * Render ACL-specific footer with controls
   * @private
   */
  _renderFooter() {
    const width = this.bounds.width;
    const hint = 'Tab:to ^P:perf Enter:send';
    // BL(1) + padding + hint + BR(1) = width
    // So padding = width - hint.length - 2
    const padding = width - hint.length - 2;

    // Build the line ensuring exact width
    const hBar = BOX.H.repeat(Math.max(0, padding));
    return `${BG_DARK}${FG_GRAY}${BOX.BL}${hBar}${hint}${BOX.BR}${RESET}`;
  }

  /**
   * Strip ANSI codes for length calculation
   * @private
   */
  _stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
  }

  /**
   * Get the current message state
   * @returns {Object}
   */
  getMessage() {
    return {
      performative: this.performative,
      from: this.sourceAgent,
      to: this.targetAgent,
      content: this.inputBuffer
    };
  }
}

module.exports = { ACLInputOverlay, PERFORMATIVES, PERF_COLORS };
