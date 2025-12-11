// src/layout/LayoutManager.js - Layout operations

const { Container, Pane, LayoutNode } = require('./LayoutNode');

class LayoutManager {
  constructor(session) {
    this.session = session;
    this.focusedPaneId = null;
    this.zoomedPaneId = null;   // Track zoomed pane
    this.savedLayout = null;    // Save layout before zoom
  }

  get layout() {
    return this.session.layout;
  }

  set layout(node) {
    this.session.layout = node;
  }

  /**
   * Initialize with single pane
   */
  initSinglePane(agentId) {
    this.layout = new Pane(agentId);
    this.focusedPaneId = this.layout.id;
  }

  /**
   * Find pane by ID
   */
  findPane(paneId, node = this.layout) {
    if (!node) return null;
    if (node.type === 'pane' && node.id === paneId) return node;
    if (node.type === 'container') {
      for (const child of node.children) {
        const found = this.findPane(paneId, child);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Find pane by agent ID
   */
  findPaneByAgent(agentId, node = this.layout) {
    if (!node) return null;
    if (node.type === 'pane' && node.agentId === agentId) return node;
    if (node.type === 'container') {
      for (const child of node.children) {
        const found = this.findPaneByAgent(agentId, child);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Get all panes as flat list
   */
  getAllPanes(node = this.layout) {
    if (!node) return [];
    if (node.type === 'pane') return [node];
    if (node.type === 'container') {
      return node.children.flatMap(c => this.getAllPanes(c));
    }
    return [];
  }

  /**
   * Get focused pane
   */
  getFocusedPane() {
    return this.findPane(this.focusedPaneId);
  }

  /**
   * Find pane at screen coordinates
   */
  findPaneAt(x, y) {
    for (const pane of this.getAllPanes()) {
      if (!pane.bounds) continue;
      const { x: px, y: py, width, height } = pane.bounds;
      if (x >= px && x < px + width && y >= py && y < py + height) {
        return pane;
      }
    }
    return null;
  }

  /**
   * Get agent for focused pane
   */
  getFocusedAgent() {
    const pane = this.getFocusedPane();
    if (!pane) return null;
    return this.session.getAgent(pane.agentId);
  }

  /**
   * Split focused pane
   * @param {'horizontal'|'vertical'} orientation
   * @param {string} newAgentId
   */
  split(orientation, newAgentId) {
    const focusedPane = this.findPane(this.focusedPaneId);
    if (!focusedPane) return null;

    const newPane = new Pane(newAgentId);
    const container = new Container(orientation, [0.5, 0.5]);

    // Replace focused pane with container
    if (focusedPane.parent) {
      const parent = focusedPane.parent;
      const idx = parent.children.indexOf(focusedPane);
      parent.children[idx] = container;
      container.parent = parent;
    } else {
      // Root pane
      this.layout = container;
    }

    container.children = [focusedPane, newPane];
    focusedPane.parent = container;
    newPane.parent = container;

    // Focus new pane
    this.focusedPaneId = newPane.id;
    return newPane;
  }

  splitHorizontal(newAgentId) {
    return this.split('horizontal', newAgentId);
  }

  splitVertical(newAgentId) {
    return this.split('vertical', newAgentId);
  }

  /**
   * Close focused pane
   */
  closePane() {
    const pane = this.findPane(this.focusedPaneId);
    if (!pane) return false;

    // Can't close if it's the only pane
    if (!pane.parent) return false;

    const parent = pane.parent;
    const siblingIdx = parent.children.indexOf(pane) === 0 ? 1 : 0;
    const sibling = parent.children[siblingIdx];

    // Replace parent with sibling
    if (parent.parent) {
      const grandparent = parent.parent;
      const idx = grandparent.children.indexOf(parent);
      grandparent.children[idx] = sibling;
      sibling.parent = grandparent;
    } else {
      // Parent was root
      this.layout = sibling;
      sibling.parent = null;
    }

    // Focus sibling or first pane in sibling
    if (sibling.type === 'pane') {
      this.focusedPaneId = sibling.id;
    } else {
      const panes = this.getAllPanes(sibling);
      this.focusedPaneId = panes[0]?.id || null;
    }

    return true;
  }

  /**
   * Close all panes except focused
   */
  closeOthers() {
    const focusedPane = this.findPane(this.focusedPaneId);
    if (!focusedPane) return;

    // Make focused pane the root
    focusedPane.parent = null;
    this.layout = focusedPane;
  }

  /**
   * Calculate bounds for all nodes
   * @param {number} x - Start x
   * @param {number} y - Start y (after tab bar)
   * @param {number} width - Available width
   * @param {number} height - Available height
   */
  calculateBounds(x, y, width, height, node = this.layout) {
    if (!node) return;

    node.bounds = { x, y, width, height };

    if (node.type === 'container') {
      let offset = 0;
      const isHorizontal = node.orientation === 'horizontal';
      const totalSize = isHorizontal ? width : height;

      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        const ratio = node.ratios[i] || (1 / node.children.length);
        const size = Math.floor(totalSize * ratio);

        // Account for border (1 char) between panes
        const borderOffset = i < node.children.length - 1 ? 1 : 0;

        if (isHorizontal) {
          this.calculateBounds(x + offset, y, size - borderOffset, height, child);
        } else {
          this.calculateBounds(x, y + offset, width, size - borderOffset, child);
        }

        offset += size;
      }
    }
  }

  /**
   * Focus pane by ID
   */
  focusPane(paneId) {
    const pane = this.findPane(paneId);
    if (pane) {
      this.focusedPaneId = paneId;
      return true;
    }
    return false;
  }

  /**
   * Focus pane by agent ID
   */
  focusPaneByAgent(agentId) {
    const pane = this.findPaneByAgent(agentId);
    if (pane) {
      this.focusedPaneId = pane.id;
      return true;
    }
    return false;
  }

  /**
   * Focus navigation by direction
   */
  focusDirection(dir) {
    const panes = this.getAllPanes();
    const current = this.findPane(this.focusedPaneId);
    if (!current || panes.length < 2) return;

    let best = null;
    let bestDist = Infinity;

    const cx = current.bounds.x + current.bounds.width / 2;
    const cy = current.bounds.y + current.bounds.height / 2;

    for (const pane of panes) {
      if (pane.id === current.id) continue;

      const px = pane.bounds.x + pane.bounds.width / 2;
      const py = pane.bounds.y + pane.bounds.height / 2;

      const dx = px - cx;
      const dy = py - cy;

      let valid = false;
      switch (dir) {
        case 'left':  valid = dx < 0 && Math.abs(dx) > Math.abs(dy); break;
        case 'right': valid = dx > 0 && Math.abs(dx) > Math.abs(dy); break;
        case 'up':    valid = dy < 0 && Math.abs(dy) > Math.abs(dx); break;
        case 'down':  valid = dy > 0 && Math.abs(dy) > Math.abs(dx); break;
      }

      if (valid) {
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist < bestDist) {
          bestDist = dist;
          best = pane;
        }
      }
    }

    if (best) {
      this.focusedPaneId = best.id;
    }
  }

  /**
   * Cycle focus to next/prev pane
   */
  cycleFocus(forward = true) {
    const panes = this.getAllPanes();
    if (panes.length < 2) return;

    const currentIdx = panes.findIndex(p => p.id === this.focusedPaneId);
    if (currentIdx === -1) {
      this.focusedPaneId = panes[0].id;
      return;
    }

    const nextIdx = forward
      ? (currentIdx + 1) % panes.length
      : (currentIdx - 1 + panes.length) % panes.length;

    this.focusedPaneId = panes[nextIdx].id;
  }

  /**
   * Resize focused pane
   */
  resizeFocused(delta) {
    const pane = this.findPane(this.focusedPaneId);
    if (!pane || !pane.parent) return;

    const parent = pane.parent;
    const idx = parent.children.indexOf(pane);

    // Adjust ratio
    const change = delta / 100;
    parent.ratios[idx] = Math.max(0.1, Math.min(0.9, parent.ratios[idx] + change));

    // Normalize ratios
    const total = parent.ratios.reduce((a, b) => a + b, 0);
    parent.ratios = parent.ratios.map(r => r / total);
  }

  /**
   * Equalize all pane sizes
   */
  equalize(node = this.layout) {
    if (!node || node.type !== 'container') return;

    const n = node.children.length;
    node.ratios = Array(n).fill(1 / n);

    for (const child of node.children) {
      this.equalize(child);
    }
  }

  /**
   * Toggle zoom on focused pane
   * @returns {boolean} - true if now zoomed, false if unzoomed
   */
  toggleZoom() {
    if (this.zoomedPaneId) {
      // Unzoom: restore saved layout
      this.layout = this.savedLayout;
      this.zoomedPaneId = null;
      this.savedLayout = null;
      return false;
    } else {
      // Can't zoom if only one pane
      const panes = this.getAllPanes();
      if (panes.length < 2) return false;

      // Zoom: save layout, make focused pane fullscreen
      this.savedLayout = this.layout;
      this.zoomedPaneId = this.focusedPaneId;

      // Create a detached copy of the focused pane for zoom view
      const pane = this.findPane(this.focusedPaneId);
      if (!pane) return false;

      // Temporarily set layout to just this pane (don't modify parent)
      const zoomPane = new Pane(pane.agentId);
      zoomPane.id = pane.id;  // Keep same ID for focus
      this.layout = zoomPane;

      return true;
    }
  }

  /**
   * Check if currently zoomed
   */
  isZoomed() {
    return this.zoomedPaneId !== null;
  }
}

module.exports = { LayoutManager };
