#!/usr/bin/env node
// PostToolUse hook for Claude Code agents launched by bukowski — DISABLED.
//
// This hook used to inject `additionalContext` *mid-turn* (after a tool call,
// before the turn ended) to surface pending FIPA performatives between tool
// steps. That collided with extended/interleaved thinking: a single assistant
// turn carries multiple `thinking` blocks that must be re-sent verbatim, with
// their signatures intact, on every continuation request *within* that turn.
// Injecting context into the middle of such a turn made Claude Code re-emit the
// open assistant message with an altered thinking block, and the API rejected
// the next request with:
//
//   400 messages.N.content.M: `thinking` or `redacted_thinking` blocks in the
//   latest assistant message cannot be modified.
//
// (Note: this is NOT the empty-text-after-image-paste trigger from
// anthropics/claude-code#50375 — that pattern never appears in our transcripts.
// The mid-turn injection below was our own trigger for the same error class.)
//
// Delivery now happens only at safe turn boundaries: the Stop hook blocks the
// stop and passes pending messages as the continuation reason (the turn is
// closed there, so no thinking block needs preserving), and UserPromptSubmit
// covers messages already pending when a prompt is submitted. Both already peek
// every performative, so nothing is lost except sub-turn latency.
//
// The script is kept as a quiet no-op so that agents still running with the
// older `--settings` (which references this path) degrade safely the next time
// the hook fires — the file is re-read from disk on each invocation.

'use strict';

process.exit(0);
