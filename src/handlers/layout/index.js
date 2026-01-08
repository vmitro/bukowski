/**
 * Layout handlers - pane navigation, splits, tabs
 */

const { focusHandlers } = require('./focusHandlers');
const { splitHandlers } = require('./splitHandlers');

// Combine all layout handlers
const layoutHandlers = {
  ...focusHandlers,
  ...splitHandlers
};

module.exports = { layoutHandlers, focusHandlers, splitHandlers };
