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
   * Calculate bounds for all nodes using integer-proportional distribution
   * @param {number} x - Start x
   * @param {number} y - Start y (after tab bar)
   * @param {number} width - Available width
   * @param {number} height - Available height
   */
  calculateBounds(x, y, width, height, node = this.layout) {
    if (!node) return;

    node.bounds = { x, y, width, height };

    if (node.type === 'container') {
      const isHorizontal = node.orientation === 'horizontal';
      const totalSize = isHorizontal ? width : height;
      const n = node.children.length;

      // Convert ratios to integer weights (scale by 10000 for precision)
      const weights = node.ratios.map(r => Math.round(r * 10000));
      const totalWeight = weights.reduce((a, b) => a + b, 0);

      // Account for borders between panes (n-1 borders, 1 char each)
      const borderSpace = n - 1;
      const availableSize = totalSize - borderSpace;

      // Distribute sizes proportionally using integer math
      // This ensures consistent rounding regardless of terminal size
      const sizes = this.distributeProportionally(availableSize, weights, totalWeight);

      let offset = 0;
      for (let i = 0; i < n; i++) {
        const child = node.children[i];
        const size = sizes[i];

        if (isHorizontal) {
          this.calculateBounds(x + offset, y, size, height, child);
        } else {
          this.calculateBounds(x, y + offset, width, size, child);
        }

        // Add border space after each child except last
        offset += size + (i < n - 1 ? 1 : 0);
      }
    }
  }

  /**
   * Distribute a total among parts proportionally using integer arithmetic
   * Uses largest remainder method for fair distribution
   * @param {number} total - Total to distribute
   * @param {number[]} weights - Integer weights for each part
   * @param {number} totalWeight - Sum of weights
   * @returns {number[]} - Sizes for each part
   */
  distributeProportionally(total, weights, totalWeight) {
    const n = weights.length;
    if (n === 0) return [];
    if (totalWeight === 0) {
      // Fallback: equal distribution
      const base = Math.floor(total / n);
      const remainder = total - base * n;
      return weights.map((_, i) => base + (i < remainder ? 1 : 0));
    }

    // Calculate base sizes and remainders
    const sizes = [];
    const remainders = [];
    let allocated = 0;

    for (let i = 0; i < n; i++) {
      // Use integer multiplication then division to minimize rounding errors
      const exact = (total * weights[i]) / totalWeight;
      const base = Math.floor(exact);
      sizes.push(base);
      remainders.push({ index: i, fraction: exact - base });
      allocated += base;
    }

    // Distribute remaining pixels to those with largest remainders
    let leftover = total - allocated;
    remainders.sort((a, b) => b.fraction - a.fraction);

    for (let i = 0; i < leftover && i < remainders.length; i++) {
      sizes[remainders[i].index]++;
    }

    return sizes;
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
   * Find the nearest resizable border to a screen position
   * @param {number} x - Screen X
   * @param {number} y - Screen Y
   * @param {'horizontal'|'vertical'} orientation - Which border type to find
   * @returns {{container, borderIndex, position}|null}
   */
  findBorderAt(x, y, orientation, node = this.layout) {
    if (!node || node.type !== 'container') return null;

    // Check this container's borders
    if (node.orientation === orientation && node.children.length > 1) {
      const { x: nx, y: ny, width, height } = node.bounds;
      const isHorizontal = orientation === 'horizontal';
      const totalSize = isHorizontal ? width : height;

      let offset = 0;
      for (let i = 0; i < node.children.length - 1; i++) {
        const ratio = node.ratios[i] || (1 / node.children.length);
        const size = Math.floor(totalSize * ratio);
        offset += size;

        // Border is at offset position (1 char wide)
        const borderPos = isHorizontal ? nx + offset - 1 : ny + offset - 1;
        const threshold = 2; // Click within 2 chars of border

        if (isHorizontal) {
          // Vertical border (for horizontal layout)
          if (Math.abs(x - borderPos) <= threshold && y >= ny && y < ny + height) {
            return { container: node, borderIndex: i, position: borderPos };
          }
        } else {
          // Horizontal border (for vertical layout)
          if (Math.abs(y - borderPos) <= threshold && x >= nx && x < nx + width) {
            return { container: node, borderIndex: i, position: borderPos };
          }
        }
      }
    }

    // Recurse into children
    for (const child of node.children || []) {
      const found = this.findBorderAt(x, y, orientation, child);
      if (found) return found;
    }

    return null;
  }

  /**
   * Find container by pane position for directional resize
   * @param {number} x - Screen X
   * @param {number} y - Screen Y
   * @param {'horizontal'|'vertical'} orientation - Container orientation to find
   * @returns {{container, childIndex}|null}
   */
  findContainerForResize(x, y, orientation) {
    const pane = this.findPaneAt(x, y);
    if (!pane) return null;

    // Walk up the tree to find a container with matching orientation
    let node = pane;
    while (node.parent) {
      const parent = node.parent;
      if (parent.orientation === orientation && parent.children.length > 1) {
        const idx = parent.children.indexOf(node);
        return { container: parent, childIndex: idx };
      }
      node = parent;
    }
    return null;
  }

  /**
   * Resize a container's border using integer-proportional adjustment
   * @param {Container} container - The container to resize
   * @param {number} borderIndex - Which border (0 = between child 0 and 1)
   * @param {number} delta - Positive = grow left/top child, negative = shrink
   */
  resizeBorder(container, borderIndex, delta) {
    if (!container || container.type !== 'container') return;
    if (borderIndex < 0 || borderIndex >= container.children.length - 1) return;

    // Convert to integer weights if not already (scale by 1000 for precision)
    let weights = container.ratios.map(r => Math.round(r * 1000));

    // Apply delta (scale appropriately)
    const change = delta * 10; // Each scroll step = 1% of total
    weights[borderIndex] = Math.max(50, weights[borderIndex] + change);
    weights[borderIndex + 1] = Math.max(50, weights[borderIndex + 1] - change);

    // Normalize back to ratios
    const total = weights.reduce((a, b) => a + b, 0);
    container.ratios = weights.map(w => w / total);
  }

  /**
   * Resize pane at position in given direction
   * @param {number} x - Mouse X
   * @param {number} y - Mouse Y
   * @param {'horizontal'|'vertical'} direction - Resize direction
   * @param {number} delta - Positive = grow, negative = shrink
   */
  resizeAtPosition(x, y, direction, delta) {
    // Map direction to container orientation:
    // - 'vertical' resize means adjusting a horizontal split (vertical container)
    // - 'horizontal' resize means adjusting a vertical split (horizontal container)
    const orientation = direction === 'vertical' ? 'vertical' : 'horizontal';

    const result = this.findContainerForResize(x, y, orientation);
    if (!result) return false;

    const { container, childIndex } = result;

    // Determine which border to adjust
    // If we're not the last child, resize the border after us
    // If we're the last child, resize the border before us
    let borderIndex;
    if (childIndex < container.children.length - 1) {
      borderIndex = childIndex;
    } else {
      borderIndex = childIndex - 1;
      delta = -delta; // Reverse direction for last child
    }

    this.resizeBorder(container, borderIndex, delta);
    return true;
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

  /**
   * Find pane in direction WITHOUT focusing it (for ACL targeting)
   * @param {string} dir - 'left' | 'right' | 'up' | 'down'
   * @returns {Pane|null} - The pane in that direction, or null if none
   */
  findPaneInDirection(dir) {
    const panes = this.getAllPanes();
    const current = this.findPane(this.focusedPaneId);
    if (!current || panes.length < 2) return null;

    const cx = current.bounds.x + current.bounds.width / 2;
    const cy = current.bounds.y + current.bounds.height / 2;

    let best = null;
    let bestDist = Infinity;

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

    return best;
  }
}

module.exports = { LayoutManager };
