#!/usr/bin/env bash
# Client-independent tmux-resurrect save.
#
# tmux-continuum autosaves only while a client is attached and the status bar
# redraws (its save hook lives in status-right). Detach every client, or leave
# the session idle, and autosave silently stops — that is how the Nov-5 fleet
# went two months without a single save and was unrecoverable from resurrect.
#
# This wrapper runs resurrect's save.sh directly against the running tmux server,
# needing no attached client, so a systemd timer can snapshot on a fixed cadence
# regardless of who is looking. It is best-effort: if no server is up (or it has
# no real panes) there is nothing to save and we exit 0 without clobbering the
# last good snapshot. Belt-and-braces to continuum, not a replacement.
set -uo pipefail

LOG="${BUKOWSKI_FLEET_SAVE_LOG:-$HOME/.bukowski/fleet-save.log}"
SAVE="${RESURRECT_SAVE:-$HOME/.tmux/plugins/tmux-resurrect/scripts/save.sh}"
stamp() { date -Is; }

mkdir -p "$(dirname "$LOG")"

# A tmux server must be up; otherwise nothing to snapshot (not an error).
if ! tmux has-session 2>/dev/null; then
  echo "$(stamp) skip: no tmux server" >>"$LOG"
  exit 0
fi

# Guard against snapshotting an empty server (would overwrite a good save with
# nothing). Require at least one pane across all sessions.
panes=$(tmux list-panes -a 2>/dev/null | wc -l)
if [ "${panes:-0}" -lt 1 ]; then
  echo "$(stamp) skip: server has no panes" >>"$LOG"
  exit 0
fi

if [ ! -x "$SAVE" ]; then
  echo "$(stamp) ERROR: resurrect save.sh not executable at $SAVE" >>"$LOG"
  exit 1
fi

if "$SAVE" >>"$LOG" 2>&1; then
  echo "$(stamp) saved ($panes panes)" >>"$LOG"
else
  echo "$(stamp) ERROR: save.sh exit $?" >>"$LOG"
  exit 1
fi
