// src/ui/TabBar.js - Tab bar with dynamic width and overflow

class TabBar {
  constructor() {
    this.tabs = [];        // { id, name, active, status }
    this.scrollOffset = 0; // For overflow scrolling
    this.sessionName = null; // Session name (null = untitled)
  }

  setTabs(tabs) {
    this.tabs = tabs;
  }

  setSessionName(name) {
    this.sessionName = name || null;
  }

  /**
   * Calculate tab widths and visible range
   * @param {number} termWidth - Terminal width in columns
   * @returns {{ tabWidth: number, visibleStart: number, visibleEnd: number, hasOverflowLeft: boolean, hasOverflowRight: boolean }}
   */
  calcLayout(termWidth) {
    const n = this.tabs.length;
    if (n === 0) return { tabWidth: 0, visibleStart: 0, visibleEnd: 0, hasOverflowLeft: false, hasOverflowRight: false };

    // Reserve 4 chars for potential << and >> indicators
    const availableWidth = termWidth - 4;

    // Each tab gets equal share, min 8 chars
    const idealWidth = Math.floor(termWidth / n);
    const tabWidth = Math.max(8, Math.min(idealWidth, 30)); // Max 30 chars per tab

    // How many tabs fit?
    const visibleCount = Math.max(1, Math.floor(availableWidth / tabWidth));

    // Clamp scroll offset
    const maxOffset = Math.max(0, n - visibleCount);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
    this.scrollOffset = Math.max(0, this.scrollOffset);

    // Ensure active tab is visible
    const activeIdx = this.tabs.findIndex(t => t.active);
    if (activeIdx !== -1) {
      if (activeIdx < this.scrollOffset) {
        this.scrollOffset = activeIdx;
      } else if (activeIdx >= this.scrollOffset + visibleCount) {
        this.scrollOffset = activeIdx - visibleCount + 1;
      }
    }

    const visibleStart = this.scrollOffset;
    const visibleEnd = Math.min(n, visibleStart + visibleCount);

    return {
      tabWidth,
      visibleStart,
      visibleEnd,
      hasOverflowLeft: visibleStart > 0,
      hasOverflowRight: visibleEnd < n
    };
  }

  scrollLeft() {
    this.scrollOffset = Math.max(0, this.scrollOffset - 1);
  }

  scrollRight() {
    this.scrollOffset += 1; // Will be clamped in calcLayout
  }

  /**
   * Render tab bar to string
   * @param {number} termWidth
   * @returns {string}
   */
  render(termWidth) {
    let output = '';

    // Session name on the left (dim styling)
    // Truncate to max 1/3 of terminal width to leave room for tabs
    const rawName = this.sessionName || 'untitled';
    const maxNameLen = Math.max(8, Math.floor(termWidth / 3) - 2);
    const displayName = rawName.length > maxNameLen
      ? rawName.slice(0, maxNameLen - 1) + '…'
      : rawName;
    const sessionPart = ` ${displayName} `;
    output += `\x1b[90m${sessionPart}\x1b[0m`;

    // Remaining width for tabs (clamp to >= 0)
    const tabAreaWidth = Math.max(0, termWidth - sessionPart.length);

    if (this.tabs.length === 0 || tabAreaWidth < 8) {
      return output + ' '.repeat(Math.max(0, tabAreaWidth));
    }

    const { tabWidth, visibleStart, visibleEnd, hasOverflowLeft, hasOverflowRight } = this.calcLayout(tabAreaWidth);

    // Left overflow indicator
    if (hasOverflowLeft) {
      output += '\x1b[90m<<\x1b[0m';
    } else {
      output += '  ';
    }

    // Render visible tabs
    for (let i = visibleStart; i < visibleEnd; i++) {
      const tab = this.tabs[i];
      const label = this.truncateOrPad(tab.name, tabWidth - 2); // -2 for brackets

      // Status indicator
      let statusChar = ' ';
      if (tab.status === 'running') statusChar = '●';
      else if (tab.status === 'error') statusChar = '✖';
      else if (tab.status === 'stopped') statusChar = '○';

      if (tab.active) {
        // Active tab: bold, blue background
        output += `\x1b[1;44;97m[${label}]\x1b[0m`;
      } else {
        // Inactive tab: dim
        output += `\x1b[90m[${label}]\x1b[0m`;
      }
    }

    // Calculate remaining space (within tab area)
    const usedWidth = 2 + (visibleEnd - visibleStart) * tabWidth;
    const remaining = tabAreaWidth - usedWidth - 2;
    if (remaining > 0) {
      output += ' '.repeat(remaining);
    }

    // Right overflow indicator
    if (hasOverflowRight) {
      output += '\x1b[90m>>\x1b[0m';
    } else {
      output += '  ';
    }

    return output;
  }

  truncateOrPad(str, width) {
    if (width <= 0) return '';
    if (str.length > width) {
      return str.slice(0, width - 1) + '…';
    }
    return str.padEnd(width);
  }

  /**
   * Get tab index at screen position
   */
  getTabAtPosition(x, termWidth) {
    // Account for session name on the left (must match render truncation)
    const rawName = this.sessionName || 'untitled';
    const maxNameLen = Math.max(8, Math.floor(termWidth / 3) - 2);
    const displayName = rawName.length > maxNameLen
      ? rawName.slice(0, maxNameLen - 1) + '…'
      : rawName;
    const sessionPartLen = displayName.length + 2; // " name "
    const tabAreaWidth = Math.max(0, termWidth - sessionPartLen);

    if (tabAreaWidth < 8) return -1;

    const { tabWidth, visibleStart, visibleEnd, hasOverflowLeft } = this.calcLayout(tabAreaWidth);

    // Account for session name + overflow indicator
    const startX = sessionPartLen + (hasOverflowLeft ? 2 : 2);
    const relX = x - startX;

    if (relX < 0) return -1;

    const tabIdx = Math.floor(relX / tabWidth) + visibleStart;
    if (tabIdx >= visibleEnd) return -1;

    return tabIdx;
  }
}

module.exports = { TabBar };
