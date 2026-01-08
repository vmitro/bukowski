/**
 * Layout handlers - pane navigation, splits, tabs
 */

const { focusHandlers } = require('./focusHandlers');

// Combine all layout handlers
const layoutHandlers = {
  ...focusHandlers
};

module.exports = { layoutHandlers, focusHandlers };
