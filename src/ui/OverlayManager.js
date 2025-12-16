// src/ui/OverlayManager.js - Manages overlay lifecycle and focus
// Overlays are modal UI elements drawn on top of pane content

const EventEmitter = require('events');

/**
 * OverlayManager
 *
 * Manages the lifecycle of overlay windows (modals, dialogs, pickers).
 * Overlays are rendered on top of all pane content by the Compositor.
 *
 * Only one overlay can be focused at a time. Input is routed to the
 * focused overlay until it's dismissed.
 */
class OverlayManager extends EventEmitter {
  constructor() {
    super();

    // Active overlays indexed by ID
    this.overlays = new Map();

    // Currently focused overlay ID (receives input)
    this.focusedId = null;

    // Z-order stack (last = top)
    this.zOrder = [];
  }

  /**
   * Show a new overlay
   * @param {Object} config - Overlay configuration
   * @param {string} config.id - Unique overlay ID
   * @param {string} config.type - Overlay type for factory dispatch
   * @param {number} config.x - X position (0-indexed)
   * @param {number} config.y - Y position (0-indexed)
   * @param {number} config.width - Initial width
   * @param {number} config.height - Initial height
   * @param {Object} [config.options] - Type-specific options
   * @returns {Overlay}
   */
  show(config) {
    // Import here to avoid circular dependency
    const { createOverlay } = require('./Overlay');

    const overlay = createOverlay(config);
    this.overlays.set(config.id, overlay);
    this.zOrder.push(config.id);
    this.focusedId = config.id;

    this.emit('overlay:show', overlay);
    return overlay;
  }

  /**
   * Hide/close an overlay
   * @param {string} id - Overlay ID
   */
  hide(id) {
    const overlay = this.overlays.get(id);
    if (!overlay) return;

    this.overlays.delete(id);
    this.zOrder = this.zOrder.filter(zid => zid !== id);

    // Focus the next overlay in stack, or null
    if (this.focusedId === id) {
      this.focusedId = this.zOrder.length > 0
        ? this.zOrder[this.zOrder.length - 1]
        : null;
    }

    this.emit('overlay:hide', id);
  }

  /**
   * Get overlay by ID
   * @param {string} id
   * @returns {Overlay|null}
   */
  get(id) {
    return this.overlays.get(id) || null;
  }

  /**
   * Get the currently focused overlay
   * @returns {Overlay|null}
   */
  getFocused() {
    return this.focusedId ? this.overlays.get(this.focusedId) : null;
  }

  /**
   * Check if any overlay is active
   * @returns {boolean}
   */
  hasActiveOverlay() {
    return this.overlays.size > 0;
  }

  /**
   * Focus a specific overlay (bring to front)
   * @param {string} id
   */
  focus(id) {
    if (!this.overlays.has(id)) return;

    // Move to top of z-order
    this.zOrder = this.zOrder.filter(zid => zid !== id);
    this.zOrder.push(id);
    this.focusedId = id;

    this.emit('overlay:focus', id);
  }

  /**
   * Handle input for the focused overlay
   * @param {string} data - Input data (key/sequence)
   * @returns {Object} - Action result from overlay
   */
  handleInput(data) {
    const overlay = this.getFocused();
    if (!overlay) {
      return { action: 'no_overlay' };
    }

    return overlay.handleInput(data);
  }

  /**
   * Update overlay position (e.g., for centering on resize)
   * @param {string} id
   * @param {Object} bounds - New { x, y, width, height }
   */
  updateBounds(id, bounds) {
    const overlay = this.overlays.get(id);
    if (overlay) {
      Object.assign(overlay.bounds, bounds);
      this.emit('overlay:resize', id);
    }
  }

  /**
   * Get all overlays in z-order (for rendering)
   * @returns {Overlay[]}
   */
  getAllInOrder() {
    return this.zOrder.map(id => this.overlays.get(id)).filter(Boolean);
  }

  /**
   * Clear all overlays
   */
  clear() {
    for (const id of [...this.overlays.keys()]) {
      this.hide(id);
    }
  }

  /**
   * Center an overlay on screen
   * @param {string} id
   * @param {number} screenCols
   * @param {number} screenRows
   */
  center(id, screenCols, screenRows) {
    const overlay = this.overlays.get(id);
    if (!overlay) return;

    overlay.bounds.x = Math.floor((screenCols - overlay.bounds.width) / 2);
    overlay.bounds.y = Math.floor((screenRows - overlay.bounds.height) / 2);
  }
}

module.exports = { OverlayManager };
