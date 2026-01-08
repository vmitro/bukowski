/**
 * HandlerContext - Provides explicit dependencies for action handlers
 *
 * All handler functions receive (ctx, payload) where ctx is a HandlerContext.
 * This avoids closures over module locals and makes dependencies explicit.
 */

class HandlerContext {
  constructor(options) {
    // Core services
    this.session = options.session;
    this.layoutManager = options.layoutManager;
    this.compositor = options.compositor;
    this.inputRouter = options.inputRouter;
    this.registerManager = options.registerManager;
    this.fipaHub = options.fipaHub;
    this.overlayManager = options.overlayManager;
    this.terminal = options.terminal;

    // Mutable state objects (preserve identity - never replace, only mutate)
    this.vimState = options.vimState;
    this.searchState = options.searchState;
    this.commandState = options.commandState;
    this.chatState = options.chatState;
    this.aclState = options.aclState;

    // Callbacks for operations that would cause cyclic imports
    this.onHandleResize = options.onHandleResize || (() => {});
    this.onHandleAction = options.onHandleAction || (() => {});
    this.onExecuteCommand = options.onExecuteCommand || (() => {});
    this.onCreateNewAgent = options.onCreateNewAgent || (() => null);
    this.onSetupAgentHandlers = options.onSetupAgentHandlers || (() => {});
    this.onCreateChatPane = options.onCreateChatPane || (() => null);
    this.onShowConversationPicker = options.onShowConversationPicker || (() => {});
    this.onFocusOrCreateChatPane = options.onFocusOrCreateChatPane || (() => {});
    this.onYankSelection = options.onYankSelection || (() => {});
    this.onEnterVisualMode = options.onEnterVisualMode || (() => {});
    this.onMoveVisualCursor = options.onMoveVisualCursor || (() => {});
    this.onExecuteSearch = options.onExecuteSearch || (() => {});
    this.onJumpToMatch = options.onJumpToMatch || (() => {});
    this.onPasteFromRegister = options.onPasteFromRegister || (() => {});

    // UI components
    this.chatPane = options.chatPane;

    // IPC hub reference (for quit handlers)
    this.ipcHub = options.ipcHub;

    // Agent types config
    this.AGENT_TYPES = options.AGENT_TYPES;
  }

  // Convenience getters
  getFocusedPane() {
    return this.layoutManager.getFocusedPane();
  }

  getFocusedAgent() {
    const pane = this.getFocusedPane();
    return pane ? this.session.getAgent(pane.agentId) : null;
  }

  getFocusedPaneId() {
    return this.layoutManager.focusedPaneId;
  }

  // Ensure a line is visible in the focused pane
  ensureLineVisible(line) {
    const paneId = this.getFocusedPaneId();
    const pane = this.layoutManager.findPane(paneId);
    if (!pane) return;

    let scrollY = this.compositor.scrollOffsets.get(paneId) || 0;
    const { height } = pane.bounds;

    if (line < scrollY) {
      this.compositor.scrollOffsets.set(paneId, line);
    } else if (line >= scrollY + height) {
      this.compositor.scrollOffsets.set(paneId, line - height + 1);
    }
  }

  // Schedule a redraw
  scheduleDraw() {
    this.compositor.scheduleDraw();
  }

  // Immediate draw
  draw() {
    this.compositor.draw();
  }

  // Get scroll offset for a pane
  getScrollOffset(paneId) {
    return this.compositor.scrollOffsets.get(paneId) || 0;
  }

  // Set scroll offset for a pane
  setScrollOffset(paneId, offset) {
    this.compositor.scrollOffsets.set(paneId, offset);
  }
}

module.exports = { HandlerContext };
