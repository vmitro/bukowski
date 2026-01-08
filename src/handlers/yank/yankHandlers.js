// src/handlers/yank/yankHandlers.js - Yank, delete, paste, and register handlers

const {
  extractLines,
  extractWord,
  extractToEndOfLine,
  extractFromStartOfLine
} = require('../../utils/bufferText');

const yankHandlers = {
  yank_selection(ctx, result) {
    ctx.onYankSelection(result.register);
  },

  delete_selection(ctx, result) {
    // First yank to register, then we would delete (but in a read-only terminal, just yank)
    ctx.onYankSelection(result.register);
  },

  yank_lines(ctx, result) {
    const focusedAgent = ctx.getFocusedAgent();
    if (!focusedAgent) return;

    const text = extractLines(focusedAgent, ctx.vimState.normalCursor.line, result.count || 1);
    const reg = result.register?.toLowerCase();
    const append = result.register && /[A-Z]/.test(result.register);

    if (reg === '+' || reg === '*') {
      ctx.registerManager.setClipboard(text);
    } else {
      ctx.registerManager.yank(focusedAgent.id, text, 'line', reg, append);
      // Sync to clipboard if no specific register
      if (!result.register) {
        const b64 = Buffer.from(text).toString('base64');
        process.stdout.write(`\x1b]52;c;${b64}\x07`);
      }
    }
  },

  yank_word(ctx, result) {
    const focusedAgent = ctx.getFocusedAgent();
    if (!focusedAgent) return;

    const { text } = extractWord(focusedAgent, ctx.vimState.normalCursor.line, ctx.vimState.normalCursor.col);
    if (!text) return;

    const reg = result.register?.toLowerCase();
    const append = result.register && /[A-Z]/.test(result.register);

    if (reg === '+' || reg === '*') {
      ctx.registerManager.setClipboard(text);
    } else {
      ctx.registerManager.yank(focusedAgent.id, text, 'char', reg, append);
      if (!result.register) {
        const b64 = Buffer.from(text).toString('base64');
        process.stdout.write(`\x1b]52;c;${b64}\x07`);
      }
    }
  },

  yank_to_eol(ctx, result) {
    const focusedAgent = ctx.getFocusedAgent();
    if (!focusedAgent) return;

    const text = extractToEndOfLine(focusedAgent, ctx.vimState.normalCursor.line, ctx.vimState.normalCursor.col);
    if (!text) return;

    const reg = result.register?.toLowerCase();
    const append = result.register && /[A-Z]/.test(result.register);

    if (reg === '+' || reg === '*') {
      ctx.registerManager.setClipboard(text);
    } else {
      ctx.registerManager.yank(focusedAgent.id, text, 'char', reg, append);
      if (!result.register) {
        const b64 = Buffer.from(text).toString('base64');
        process.stdout.write(`\x1b]52;c;${b64}\x07`);
      }
    }
  },

  yank_to_bol(ctx, result) {
    const focusedAgent = ctx.getFocusedAgent();
    if (!focusedAgent) return;

    const text = extractFromStartOfLine(focusedAgent, ctx.vimState.normalCursor.line, ctx.vimState.normalCursor.col);
    if (!text) return;

    const reg = result.register?.toLowerCase();
    const append = result.register && /[A-Z]/.test(result.register);

    if (reg === '+' || reg === '*') {
      ctx.registerManager.setClipboard(text);
    } else {
      ctx.registerManager.yank(focusedAgent.id, text, 'char', reg, append);
      if (!result.register) {
        const b64 = Buffer.from(text).toString('base64');
        process.stdout.write(`\x1b]52;c;${b64}\x07`);
      }
    }
  },

  yank_to_start(ctx, result) {
    // ygg - yank from current line to buffer start
    const focusedAgent = ctx.getFocusedAgent();
    if (!focusedAgent) return;

    const lines = [];
    for (let i = 0; i <= ctx.vimState.normalCursor.line; i++) {
      lines.push(focusedAgent.getLineText(i));
    }
    const text = lines.join('\n');
    if (!text) return;

    const reg = result.register?.toLowerCase();
    const append = result.register && /[A-Z]/.test(result.register);

    if (reg === '+' || reg === '*') {
      ctx.registerManager.setClipboard(text);
    } else {
      ctx.registerManager.yank(focusedAgent.id, text, 'line', reg, append);
      if (!result.register) {
        const b64 = Buffer.from(text).toString('base64');
        process.stdout.write(`\x1b]52;c;${b64}\x07`);
      }
    }
  },

  yank_to_end(ctx, result) {
    // yG - yank from current line to buffer end
    const focusedAgent = ctx.getFocusedAgent();
    if (!focusedAgent) return;

    const contentHeight = focusedAgent.getContentHeight();
    const lines = [];
    for (let i = ctx.vimState.normalCursor.line; i < contentHeight; i++) {
      lines.push(focusedAgent.getLineText(i));
    }
    const text = lines.join('\n');
    if (!text) return;

    const reg = result.register?.toLowerCase();
    const append = result.register && /[A-Z]/.test(result.register);

    if (reg === '+' || reg === '*') {
      ctx.registerManager.setClipboard(text);
    } else {
      ctx.registerManager.yank(focusedAgent.id, text, 'line', reg, append);
      if (!result.register) {
        const b64 = Buffer.from(text).toString('base64');
        process.stdout.write(`\x1b]52;c;${b64}\x07`);
      }
    }
  },

  // Delete operators - in read-only terminal, these are no-ops
  delete_lines(_ctx, _result) {},
  delete_word(_ctx, _result) {},
  delete_word_end(_ctx, _result) {},
  delete_to_eol(_ctx, _result) {},
  delete_to_bol(_ctx, _result) {},
  delete_to_first_nonblank(_ctx, _result) {},
  delete_to_start(_ctx, _result) {},
  delete_to_end(_ctx, _result) {},

  paste(ctx, result) {
    ctx.onPasteFromRegister(result.after, result.register);
  },

  await_register(ctx, _result) {
    ctx.vimState.awaitingRegister = true;
  },

  register_selected(ctx, result) {
    ctx.vimState.selectedRegister = result.register;
    ctx.vimState.awaitingRegister = false;
  },

  // These are handled by InputRouter state, nothing to do here
  await_motion(_ctx, _result) {},
  operator_cancelled(_ctx, _result) {},
  invalid_motion(_ctx, _result) {},
  invalid_register(_ctx, _result) {}
};

module.exports = { yankHandlers };
