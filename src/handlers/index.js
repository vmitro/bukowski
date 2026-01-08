/**
 * Action handlers module
 *
 * Exports ActionDispatcher and HandlerContext for handling input actions.
 * Handlers are organized by domain: vim, layout, search, session, acl
 */

const { HandlerContext } = require('./HandlerContext');
const { layoutHandlers } = require('./layout');
const { vimHandlers } = require('./vim');
const { searchHandlers } = require('./search');
const { sessionHandlers } = require('./session');

// Handler registries - populated from extracted handler modules
const handlers = {
  ...layoutHandlers,
  ...vimHandlers,
  ...searchHandlers,
  ...sessionHandlers
};

/**
 * ActionDispatcher - Routes actions to appropriate handlers
 *
 * Initially acts as a compatibility layer, forwarding to existing handleAction.
 * As handlers are extracted, they're registered here and called directly.
 */
class ActionDispatcher {
  constructor() {
    this.context = null;
    this.handlers = { ...handlers };
    this.fallbackHandler = null; // For unextracted actions
  }

  /**
   * Set the handler context (call once after all dependencies available)
   */
  setContext(options) {
    this.context = new HandlerContext(options);
  }

  /**
   * Set fallback handler for actions not yet extracted
   * @param {Function} handler - (result) => void
   */
  setFallbackHandler(handler) {
    this.fallbackHandler = handler;
  }

  /**
   * Register a handler for an action
   * @param {string} action - Action name
   * @param {Function} handler - (ctx, payload) => void
   */
  register(action, handler) {
    this.handlers[action] = handler;
  }

  /**
   * Register multiple handlers at once
   * @param {Object} handlerMap - { actionName: handler }
   */
  registerAll(handlerMap) {
    Object.assign(this.handlers, handlerMap);
  }

  /**
   * Dispatch an action to its handler
   * @param {Object} result - Action payload with .action property
   */
  dispatch(result) {
    if (!result || !result.action) return;

    const handler = this.handlers[result.action];
    if (handler) {
      handler(this.context, result);
    } else if (this.fallbackHandler) {
      // Action not yet extracted - use fallback (existing handleAction)
      this.fallbackHandler(result);
    }
  }
}

module.exports = {
  ActionDispatcher,
  HandlerContext
};
