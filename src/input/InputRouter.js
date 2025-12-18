// src/input/InputRouter.js - Key routing with CTRL+Space prefix

class InputRouter {
  constructor(session, layoutManager, ipcHub, fipaHub = null) {
    this.session = session;
    this.layout = layoutManager;
    this.ipc = ipcHub;
    this.fipa = fipaHub;          // FIPA ACL hub for agent communication

    this.mode = 'insert';         // 'insert' | 'normal' | 'visual' | 'visual-line' | 'search' | 'chat'
    this.prefixActive = false;    // CTRL+Space was pressed
    this.layoutPrefix = false;    // Waiting for layout command (after 'w')
    this.ipcPrefix = false;       // Waiting for IPC command (after 'a')
    this.fipaPrefix = false;      // Waiting for FIPA ACL command (after 'f')
    this.pendingCount = '';       // For numeric prefixes like "3j"

    // Register system state
    this.awaitingRegister = false;  // Waiting for register name (after ")
    this.selectedRegister = null;   // Currently selected register
    this.pendingOperator = null;    // Pending operator: 'y' | 'd' | null
    this.pendingMotion = null;      // Pending motion: 'g' for gg

    // Command mode state
    this.commandBuffer = '';        // Store typed command
  }

  /**
   * Set FIPA hub (can be set after construction)
   */
  setFIPAHub(fipaHub) {
    this.fipa = fipaHub;
  }

  /**
   * Main input handler
   * @param {string} data - Raw input data
   * @returns {{ action: string, [key: string]: any }}
   */
  handle(data) {
    // ESC always cancels prefix and returns to insert mode
    if (data === '\x1b') {
      this.prefixActive = false;
      this.layoutPrefix = false;
      this.ipcPrefix = false;
      this.fipaPrefix = false;
      this.pendingCount = '';
      this.awaitingRegister = false;
      this.selectedRegister = null;
      this.pendingOperator = null;
      this.pendingMotion = null;
      this.commandBuffer = '';

      if (this.mode === 'command') {
        this.mode = 'normal';
        return { action: 'command_cancel' };
      }
      if (this.mode === 'search') {
        return { action: 'search_cancel' };
      }
      if (this.mode === 'visual' || this.mode === 'visual-line') {
        this.mode = 'normal';
        return { action: 'visual_cancel' };
      }
      if (this.mode === 'acl-send') {
        this.mode = 'insert';
        return { action: 'acl_cancel' };
      }
      if (this.mode === 'normal') {
        this.mode = 'insert';
        return { action: 'mode_change', mode: 'insert' };
      }

      // In insert mode, pass ESC through to the agent
      // (agents like Claude Code, vim, etc. need ESC to work)
      if (this.mode === 'insert') {
        return this.passToAgent(data);
      }

      return { action: 'noop' };
    }

    // CTRL+Space activates prefix mode
    if (data === '\x00') {
      this.prefixActive = true;
      return { action: 'prefix_activated' };
    }

    // Handle prefix commands
    if (this.prefixActive) {
      return this.handlePrefixCommand(data);
    }

    // Handle layout prefix (after CTRL+Space w)
    if (this.layoutPrefix) {
      this.layoutPrefix = false;
      return this.handleLayoutCommand(data);
    }

    // Handle IPC prefix (after CTRL+Space a)
    if (this.ipcPrefix) {
      this.ipcPrefix = false;
      return this.handleIPCCommand(data);
    }

    // Handle FIPA ACL prefix (after CTRL+Space f)
    if (this.fipaPrefix) {
      this.fipaPrefix = false;
      return this.handleFIPACommand(data);
    }

    // Mode-specific handling
    switch (this.mode) {
      case 'insert':
        return this.handleInsertMode(data);

      case 'normal':
        return this.handleNormalMode(data);

      case 'visual':
      case 'visual-line':
        return this.handleVisualMode(data);

      case 'search':
        return this.handleSearchMode(data);

      case 'command':
        return this.handleCommandMode(data);

      case 'chat':
        return this.handleChatMode(data);

      case 'acl-send':
        return this.handleACLSendMode(data);

      default:
        return this.passToAgent(data);
    }
  }

  /**
   * Handle CTRL+Space prefix commands
   */
  handlePrefixCommand(data) {
    this.prefixActive = false;

    switch (data) {
      // Mode switching
      case 'n':
        this.mode = 'normal';
        return { action: 'mode_change', mode: 'normal' };

      case 'i':
        this.mode = 'insert';
        return { action: 'mode_change', mode: 'insert' };

      case 'v':
        this.mode = 'visual';
        return { action: 'mode_change', mode: 'visual', start: 'current' };

      case 'V':
        this.mode = 'visual-line';
        return { action: 'mode_change', mode: 'visual-line', start: 'current' };

      // Layout prefix
      case 'w':
      case 'W':
        this.layoutPrefix = true;
        return { action: 'layout_prefix' };

      // IPC prefix
      case 'a':
      case 'A':
        this.ipcPrefix = true;
        return { action: 'ipc_prefix' };

      // FIPA ACL prefix
      case 'f':
      case 'F':
        this.fipaPrefix = true;
        return { action: 'fipa_prefix' };

      // Chat mode
      case 'c':
        this.mode = 'chat';
        return { action: 'mode_change', mode: 'chat' };

      // ACL send mode - uses visual selection if present
      case 's':
        return { action: 'acl_send_start', performative: 'inform' };

      case 'S':
        return { action: 'acl_send_start', performative: 'request' };

      // Tab switching (1-9)
      case '1': case '2': case '3': case '4': case '5':
      case '6': case '7': case '8': case '9':
        return { action: 'switch_tab', index: parseInt(data) - 1 };

      // Tab navigation
      case '[':
        return { action: 'prev_tab' };
      case ']':
        return { action: 'next_tab' };

      // Search
      case '/':
        this.mode = 'search';
        return { action: 'search_start', direction: 'forward' };

      case '?':
        this.mode = 'search';
        return { action: 'search_start', direction: 'backward' };

      // Help
      case 'H':
        return { action: 'show_help' };

      // Session management
      case 'S':
        return { action: 'save_session' };

      case 'L':
        return { action: 'load_session' };

      // Quit
      case 'q':
        return { action: 'quit_confirm' };

      case 'Q':
        return { action: 'quit_force' };

      // Command mode
      case ':':
        this.mode = 'command';
        this.commandBuffer = '';
        return { action: 'command_start' };

      default:
        return { action: 'unknown_prefix', key: data };
    }
  }

  /**
   * Handle layout commands (after CTRL+Space w)
   */
  handleLayoutCommand(key) {
    switch (key) {
      // Focus navigation
      case 'h': return { action: 'focus_direction', dir: 'left' };
      case 'j': return { action: 'focus_direction', dir: 'down' };
      case 'k': return { action: 'focus_direction', dir: 'up' };
      case 'l': return { action: 'focus_direction', dir: 'right' };

      // Focus cycling
      case 'w': return { action: 'focus_next' };
      case 'W': return { action: 'focus_prev' };

      // Split operations
      case 's': return { action: 'split_horizontal' };
      case 'v': return { action: 'split_vertical' };

      // Pane management
      case 'c': return { action: 'close_pane' };
      case 'o': return { action: 'close_others' };
      case 'z': return { action: 'zoom_toggle' };

      // Resize
      case '=': return { action: 'equalize' };
      case '+': return { action: 'resize', delta: 5 };
      case '-': return { action: 'resize', delta: -5 };
      case '>': return { action: 'resize_width', delta: 2 };
      case '<': return { action: 'resize_width', delta: -2 };

      // Swap
      case 'x': return { action: 'swap_pane' };
      case 'r': return { action: 'rotate_layout' };

      default:
        return { action: 'unknown_layout', key };
    }
  }

  /**
   * Handle IPC commands (after CTRL+Space a)
   */
  handleIPCCommand(key) {
    switch (key) {
      case 's': return { action: 'ipc_send' };
      case 'b': return { action: 'ipc_broadcast' };
      case 'l': return { action: 'ipc_log' };
      case 'c': return { action: 'ipc_connect' };
      case 'd': return { action: 'ipc_disconnect' };
      default:
        return { action: 'unknown_ipc', key };
    }
  }

  /**
   * Handle FIPA ACL commands (after CTRL+Space f)
   *
   * FIPA ACL performatives for structured agent communication:
   * - r: REQUEST - Ask agent to perform an action
   * - i: INFORM - Share information with agent
   * - q: QUERY-IF - Ask yes/no question
   * - Q: QUERY-REF - Ask for specific information
   * - c: CFP - Call for proposals (broadcast to all agents)
   * - p: PROPOSE - Submit a proposal
   * - a: AGREE - Agree to a request
   * - f: REFUSE - Refuse a request
   * - s: SUBSCRIBE - Subscribe to notifications
   * - l: List conversations - Show active FIPA conversations
   * - h: Help - Show FIPA ACL command help
   */
  handleFIPACommand(key) {
    switch (key) {
      // Core performatives
      case 'r': return { action: 'fipa_request' };        // REQUEST
      case 'i': return { action: 'fipa_inform' };         // INFORM
      case 'q': return { action: 'fipa_query_if' };       // QUERY-IF
      case 'Q': return { action: 'fipa_query_ref' };      // QUERY-REF

      // Negotiation performatives
      case 'c': return { action: 'fipa_cfp' };            // CFP (Call For Proposals)
      case 'p': return { action: 'fipa_propose' };        // PROPOSE
      case 'A': return { action: 'fipa_accept' };         // ACCEPT-PROPOSAL
      case 'R': return { action: 'fipa_reject' };         // REJECT-PROPOSAL

      // Commitment performatives
      case 'a': return { action: 'fipa_agree' };          // AGREE
      case 'f': return { action: 'fipa_refuse' };         // REFUSE
      case 'F': return { action: 'fipa_failure' };        // FAILURE

      // Subscription
      case 's': return { action: 'fipa_subscribe' };      // SUBSCRIBE

      // Conversation management
      case 'l': return { action: 'fipa_list' };           // List active conversations
      case 'v': return { action: 'fipa_view' };           // View conversation details
      case 'x': return { action: 'fipa_cancel' };         // Cancel conversation

      // Formatting style
      case '1': return { action: 'fipa_style', style: 'structured' };
      case '2': return { action: 'fipa_style', style: 'natural' };
      case '3': return { action: 'fipa_style', style: 'minimal' };

      // Help
      case 'h':
      case '?':
        return { action: 'fipa_help' };

      default:
        return { action: 'unknown_fipa', key };
    }
  }

  /**
   * Handle chat mode input
   * Chat mode allows composing FIPA ACL messages to other agents
   */
  handleChatMode(data) {
    // Enter sends the message
    if (data === '\r' || data === '\n') {
      return { action: 'chat_send' };
    }

    // ESC exits chat mode
    if (data === '\x1b') {
      this.mode = 'insert';
      return { action: 'chat_exit' };
    }

    // Backspace
    if (data === '\x7f' || data === '\b') {
      return { action: 'chat_backspace' };
    }

    // Ctrl+W: delete word
    if (data === '\x17') {
      return { action: 'chat_delete_word' };
    }

    // Ctrl+U: clear input
    if (data === '\x15') {
      return { action: 'chat_clear' };
    }

    // Tab: cycle target agent
    if (data === '\t') {
      return { action: 'chat_cycle_agent' };
    }

    // Shift+Tab (usually ESC [ Z): cycle agent backwards
    if (data === '\x1b[Z') {
      return { action: 'chat_cycle_agent_back' };
    }

    // Ctrl+P: cycle performative
    if (data === '\x10') {
      return { action: 'chat_cycle_performative' };
    }

    // Up arrow: scroll chat up
    if (data === '\x1b[A') {
      return { action: 'chat_scroll_up' };
    }

    // Down arrow: scroll chat down
    if (data === '\x1b[B') {
      return { action: 'chat_scroll_down' };
    }

    // Left/Right arrows: prev/next conversation
    if (data === '\x1b[D') {
      return { action: 'chat_prev_conversation' };
    }
    if (data === '\x1b[C') {
      return { action: 'chat_next_conversation' };
    }

    // Regular character - add to input buffer
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      return { action: 'chat_char', char: data };
    }

    // Unknown - ignore
    return { action: 'noop' };
  }

  /**
   * Handle ACL send mode - overlay-based message composition
   * Directional targeting with hjkl, Tab cycling, Ctrl+P performative cycling
   */
  handleACLSendMode(data) {
    // hjkl - target agent by direction
    if (data === 'h') return { action: 'acl_target_direction', dir: 'left' };
    if (data === 'j') return { action: 'acl_target_direction', dir: 'down' };
    if (data === 'k') return { action: 'acl_target_direction', dir: 'up' };
    if (data === 'l') return { action: 'acl_target_direction', dir: 'right' };

    // Tab - cycle target agent
    if (data === '\t') return { action: 'acl_cycle_agent' };

    // Shift+Tab - cycle agent backwards
    if (data === '\x1b[Z') return { action: 'acl_cycle_agent_back' };

    // Ctrl+P - cycle performative
    if (data === '\x10') return { action: 'acl_cycle_performative' };

    // Enter - send message
    if (data === '\r' || data === '\n') return { action: 'acl_send' };

    // ESC - cancel (handled in main handle())
    // This case won't be reached since ESC is handled at the top

    // Backspace
    if (data === '\x7f' || data === '\b') return { action: 'acl_backspace' };

    // Ctrl+W - delete word
    if (data === '\x17') return { action: 'acl_delete_word' };

    // Ctrl+U - clear input
    if (data === '\x15') return { action: 'acl_clear' };

    // Arrow keys for cursor movement within overlay
    if (data === '\x1b[D') return { action: 'acl_cursor_left' };
    if (data === '\x1b[C') return { action: 'acl_cursor_right' };

    // Regular printable character - add to input buffer
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      return { action: 'acl_char', char: data };
    }

    return { action: 'noop' };
  }

  /**
   * Handle register selection (after " key)
   */
  handleRegisterSelection(key) {
    this.awaitingRegister = false;

    // Valid register names: a-z, A-Z (append), 0-9, +, *, "
    if (/^[a-zA-Z0-9"+*]$/.test(key)) {
      this.selectedRegister = key;
      return { action: 'register_selected', register: key };
    }

    // Invalid register - cancel
    this.selectedRegister = null;
    return { action: 'invalid_register', key };
  }

  /**
   * Handle operator + motion (e.g., yy, yw, y$)
   */
  handleOperatorMotion(data) {
    const operator = this.pendingOperator;
    const register = this.selectedRegister;
    const count = parseInt(this.pendingCount) || 1;

    this.pendingOperator = null;
    this.selectedRegister = null;
    this.pendingCount = '';

    switch (data) {
      // yy - yank line(s)
      case 'y':
        if (operator === 'y') {
          return { action: 'yank_lines', count, register };
        }
        break;

      // dd - delete line(s)
      case 'd':
        if (operator === 'd') {
          return { action: 'delete_lines', count, register };
        }
        break;

      // yw - yank word
      case 'w':
        return { action: `${operator}_word`, count, register };

      // ye - yank to end of word
      case 'e':
        return { action: `${operator}_word_end`, count, register };

      // y$ - yank to end of line
      case '$':
        return { action: `${operator}_to_eol`, count, register };

      // y0 - yank to start of line
      case '0':
        return { action: `${operator}_to_bol`, count, register };

      // y^ - yank to first non-blank
      case '^':
        return { action: `${operator}_to_first_nonblank`, count, register };

      // yG - yank to end of buffer
      case 'G':
        return { action: `${operator}_to_end`, count, register };

      // ygg - yank to start of buffer (needs another g)
      case 'g':
        // Store pending motion for gg
        this.pendingOperator = operator;
        this.selectedRegister = register;
        return { action: 'await_motion', pending: `${operator}g` };

      // ESC cancels
      case '\x1b':
        return { action: 'operator_cancelled' };

      default:
        return { action: 'invalid_motion', operator, motion: data };
    }

    return { action: 'invalid_motion', operator, motion: data };
  }

  /**
   * Handle insert mode input - pass directly to agent
   */
  handleInsertMode(data) {
    return this.passToAgent(data);
  }

  /**
   * Handle normal mode (vim-like navigation)
   */
  handleNormalMode(data) {
    // Handle register selection (after " key)
    if (this.awaitingRegister) {
      return this.handleRegisterSelection(data);
    }

    // Handle operator-pending mode (after y, d, etc.)
    if (this.pendingOperator) {
      return this.handleOperatorMotion(data);
    }

    // Handle pending motion (g for gg)
    if (this.pendingMotion === 'g') {
      this.pendingMotion = null;
      if (data === 'g') {
        return { action: 'scroll_to_top' };
      }
      // Unknown g-motion, ignore
      return { action: 'noop' };
    }

    // Numeric prefix for counts (e.g., "5j" for 5 lines down)
    if (data >= '0' && data <= '9' && (this.pendingCount || data !== '0')) {
      this.pendingCount += data;
      return { action: 'count_pending', count: this.pendingCount };
    }

    const count = parseInt(this.pendingCount) || 1;
    this.pendingCount = '';

    switch (data) {
      // Register selection prefix
      case '"':
        this.awaitingRegister = true;
        return { action: 'await_register' };
      // Cursor movement (moves virtual normal cursor)
      case 'j': return { action: 'cursor_down', count };
      case 'k': return { action: 'cursor_up', count };
      case 'h': return { action: 'cursor_left', count };
      case 'l': return { action: 'cursor_right', count };

      // Word movements
      case 'w': return { action: 'word_forward', count, bigWord: false };
      case 'W': return { action: 'word_forward', count, bigWord: true };
      case 'e': return { action: 'word_end', count, bigWord: false };
      case 'E': return { action: 'word_end', count, bigWord: true };
      case 'b': return { action: 'word_backward', count, bigWord: false };
      case 'B': return { action: 'word_backward', count, bigWord: true };

      // Line position
      case '0': return { action: 'cursor_line_start' };
      case '$': return { action: 'cursor_line_end' };
      case '^': return { action: 'cursor_first_nonblank' };

      // Page navigation
      case '\x04': // Ctrl+D
        return { action: 'scroll_half_down' };
      case '\x15': // Ctrl+U
        return { action: 'scroll_half_up' };
      case '\x06': // Ctrl+F
        return { action: 'scroll_page_down' };
      case '\x02': // Ctrl+B
        return { action: 'scroll_page_up' };

      // Jump to position
      case 'g':
        this.pendingMotion = 'g';
        return { action: 'await_motion', pending: 'g' };
      case 'G':
        return { action: 'scroll_to_bottom' };

      // Mode changes
      case 'i':
        this.mode = 'insert';
        return { action: 'mode_change', mode: 'insert' };

      case 'v':
        this.mode = 'visual';
        return { action: 'mode_change', mode: 'visual', start: 'cursor' };

      case 'V':
        this.mode = 'visual-line';
        return { action: 'mode_change', mode: 'visual-line', start: 'cursor' };

      // Search
      case '/':
        this.mode = 'search';
        return { action: 'search_start', direction: 'forward' };

      case '?':
        this.mode = 'search';
        return { action: 'search_start', direction: 'backward' };

      case 'n':
        return { action: 'search_next' };

      case 'N':
        return { action: 'search_prev' };

      // Yank operator
      case 'y':
        this.pendingOperator = 'y';
        return { action: 'await_motion', operator: 'y' };

      // Delete operator
      case 'd':
        this.pendingOperator = 'd';
        return { action: 'await_motion', operator: 'd' };

      // Paste after cursor
      case 'p': {
        const pReg = this.selectedRegister;
        this.selectedRegister = null;
        return { action: 'paste', after: true, register: pReg, count };
      }

      // Paste before cursor
      case 'P': {
        const PReg = this.selectedRegister;
        this.selectedRegister = null;
        return { action: 'paste', after: false, register: PReg, count };
      }

      // Command mode
      case ':':
        this.mode = 'command';
        this.commandBuffer = '';
        return { action: 'command_start' };

      default:
        return { action: 'unknown_normal', key: data };
    }
  }

  /**
   * Handle visual mode
   */
  handleVisualMode(data) {
    const isLine = this.mode === 'visual-line';

    // Handle register selection in visual mode
    if (data === '"') {
      this.awaitingRegister = true;
      return { action: 'await_register' };
    }

    if (this.awaitingRegister) {
      return this.handleRegisterSelection(data);
    }

    // Handle pending motion (g for gg)
    if (this.pendingMotion === 'g') {
      this.pendingMotion = null;
      if (data === 'g') {
        return { action: 'extend_to_top', line: isLine };
      }
      return { action: 'noop' };
    }

    // Numeric prefix for counts
    if (data >= '0' && data <= '9' && (this.pendingCount || data !== '0')) {
      this.pendingCount += data;
      return { action: 'count_pending', count: this.pendingCount };
    }

    const count = parseInt(this.pendingCount) || 1;
    this.pendingCount = '';

    switch (data) {
      // Extend selection
      case 'j': return { action: 'extend_selection', dir: 'down', count, line: isLine };
      case 'k': return { action: 'extend_selection', dir: 'up', count, line: isLine };
      case 'h': return { action: isLine ? 'noop' : 'extend_selection', dir: 'left', count };
      case 'l': return { action: isLine ? 'noop' : 'extend_selection', dir: 'right', count };

      // Word movements
      case 'w': return { action: 'extend_word_forward', count, bigWord: false, line: isLine };
      case 'W': return { action: 'extend_word_forward', count, bigWord: true, line: isLine };
      case 'e': return { action: 'extend_word_end', count, bigWord: false, line: isLine };
      case 'E': return { action: 'extend_word_end', count, bigWord: true, line: isLine };
      case 'b': return { action: 'extend_word_backward', count, bigWord: false, line: isLine };
      case 'B': return { action: 'extend_word_backward', count, bigWord: true, line: isLine };

      // Line position
      case '0': return { action: isLine ? 'noop' : 'extend_line_start' };
      case '$': return { action: isLine ? 'noop' : 'extend_line_end' };
      case '^': return { action: isLine ? 'noop' : 'extend_first_nonblank' };

      // Page navigation while selecting
      case '\x04': return { action: 'extend_half_page', dir: 'down', line: isLine };
      case '\x15': return { action: 'extend_half_page', dir: 'up', line: isLine };

      // Jump to position
      case 'g':
        this.pendingMotion = 'g';
        return { action: 'await_motion', pending: 'g' };
      case 'G': return { action: 'extend_to_bottom', line: isLine };

      // Yank selection
      case 'y': {
        const reg = this.selectedRegister;
        this.selectedRegister = null;
        this.mode = 'normal';
        return { action: 'yank_selection', register: reg };
      }

      // Delete selection
      case 'd':
      case 'x': {
        const delReg = this.selectedRegister;
        this.selectedRegister = null;
        this.mode = 'normal';
        return { action: 'delete_selection', register: delReg };
      }

      // Cancel selection
      case 'v':
        if (!isLine) {
          this.mode = 'normal';
          return { action: 'visual_cancel' };
        }
        // Switch to char visual
        this.mode = 'visual';
        return { action: 'mode_change', mode: 'visual' };

      case 'V':
        if (isLine) {
          this.mode = 'normal';
          return { action: 'visual_cancel' };
        }
        // Switch to line visual
        this.mode = 'visual-line';
        return { action: 'mode_change', mode: 'visual-line' };

      default:
        return { action: 'unknown_visual', key: data };
    }
  }

  /**
   * Handle search mode
   */
  handleSearchMode(data) {
    // Enter confirms search
    if (data === '\r' || data === '\n') {
      this.mode = 'normal';
      return { action: 'search_confirm' };
    }

    // Backspace
    if (data === '\x7f' || data === '\b') {
      return { action: 'search_backspace' };
    }

    // Ctrl+W: delete word
    if (data === '\x17') {
      return { action: 'search_delete_word' };
    }

    // Ctrl+U: clear
    if (data === '\x15') {
      return { action: 'search_clear' };
    }

    // Regular character
    return { action: 'search_char', char: data };
  }

  /**
   * Handle command mode (ex commands like :q, :sp)
   */
  handleCommandMode(data) {
    // Enter executes command
    if (data === '\r' || data === '\n') {
      const cmd = this.commandBuffer;
      this.commandBuffer = '';
      this.mode = 'normal';
      return { action: 'command_execute', command: cmd };
    }

    // Backspace
    if (data === '\x7f' || data === '\b') {
      this.commandBuffer = this.commandBuffer.slice(0, -1);
      return { action: 'command_update', buffer: this.commandBuffer };
    }

    // Ctrl+W: delete word
    if (data === '\x17') {
      this.commandBuffer = this.commandBuffer.replace(/\S*\s*$/, '');
      return { action: 'command_update', buffer: this.commandBuffer };
    }

    // Ctrl+U: clear
    if (data === '\x15') {
      this.commandBuffer = '';
      return { action: 'command_update', buffer: this.commandBuffer };
    }

    // Regular character
    this.commandBuffer += data;
    return { action: 'command_update', buffer: this.commandBuffer };
  }

  /**
   * Pass input to focused agent
   */
  passToAgent(data) {
    const pane = this.layout.findPane(this.layout.focusedPaneId);
    if (!pane) return { action: 'no_pane' };

    const agent = this.session.getAgent(pane.agentId);
    if (!agent) return { action: 'no_agent' };

    agent.write(data);
    return { action: 'passthrough', agentId: pane.agentId };
  }

  /**
   * Set mode programmatically
   */
  setMode(mode) {
    this.mode = mode;
  }

  /**
   * Get current mode
   */
  getMode() {
    return this.mode;
  }

  /**
   * Check if in prefix mode
   */
  isPrefixActive() {
    return this.prefixActive || this.layoutPrefix || this.ipcPrefix || this.fipaPrefix;
  }

  /**
   * Get prefix state for status bar
   */
  getPrefixState() {
    if (this.prefixActive) return 'prefix';
    if (this.layoutPrefix) return 'layout';
    if (this.ipcPrefix) return 'ipc';
    if (this.fipaPrefix) return 'fipa';
    return null;
  }

  /**
   * Get register state for status bar
   */
  getRegisterState() {
    return {
      awaiting: this.awaitingRegister,
      selected: this.selectedRegister,
      operator: this.pendingOperator
    };
  }
}

module.exports = { InputRouter };
