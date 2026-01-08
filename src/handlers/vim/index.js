/**
 * Vim handlers - cursor movement, scrolling, visual mode, yank/paste
 */

const { cursorHandlers } = require('./cursorHandlers');
const { scrollHandlers } = require('./scrollHandlers');

// Combine all vim handlers
const vimHandlers = {
  ...cursorHandlers,
  ...scrollHandlers
};

module.exports = { vimHandlers, cursorHandlers, scrollHandlers };
