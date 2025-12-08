// search.js - Search handler for bukowski

class SearchHandler {
  constructor(viewport) {
    this.vp = viewport;
    this.active = false;
    this.pattern = '';
    this.matches = [];  // [{line, col, length}, ...]
    this.index = -1;
  }

  get isActive() {
    return this.active;
  }

  enter() {
    this.active = true;
    this.pattern = '';
    this.vp.draw();
  }

  handleKey(key) {
    if (key === '\r') {  // Enter
      this.execute();
      this.active = false;
      this.vp.draw();
    } else if (key === '\x1b') {  // Escape
      this.active = false;
      this.vp.draw();
    } else if (key === '\x7f' || key === '\b') {  // Backspace
      this.pattern = this.pattern.slice(0, -1);
      this.vp.draw();
    } else if (key.length === 1 && key >= ' ') {
      this.pattern += key;
      this.vp.draw();
    }
  }

  execute() {
    this.matches = [];
    if (!this.pattern) return;

    try {
      const regex = new RegExp(this.pattern, 'gi');
      const vp = this.vp;
      for (let i = 0; i < vp.contentHeight; i++) {
        const line = vp.getLineText(i);
        let match;
        while ((match = regex.exec(line)) !== null) {
          this.matches.push({ line: i, col: match.index, length: match[0].length });
        }
      }
    } catch (e) {
      // Invalid regex - ignore
    }

    if (this.matches.length > 0) {
      this.index = 0;
      this.jumpToMatch();
    }
  }

  next() {
    if (this.matches.length === 0) return;
    this.index = (this.index + 1) % this.matches.length;
    this.jumpToMatch();
  }

  prev() {
    if (this.matches.length === 0) return;
    this.index = (this.index - 1 + this.matches.length) % this.matches.length;
    this.jumpToMatch();
  }

  jumpToMatch() {
    const match = this.matches[this.index];
    const vp = this.vp;
    vp.offset = Math.max(0, match.line - Math.floor(vp.height / 2));
    vp.followTail = false;
    vp.draw();
  }

  // Check if a position should be highlighted
  isHighlighted(line, col, length) {
    return this.matches.some(m =>
      m.line === line && col >= m.col && col < m.col + m.length
    );
  }

  // Get current match info for status bar
  getStatus() {
    if (this.active) {
      return `/${this.pattern}_`;
    }
    if (this.matches.length > 0) {
      return `[${this.index + 1}/${this.matches.length}]`;
    }
    return '';
  }
}

module.exports = { SearchHandler };
