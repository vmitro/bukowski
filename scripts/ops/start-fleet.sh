#!/usr/bin/env bash
# Relaunch the bukowski fleet after a crash/reboot.
#
# tmux-continuum restores the WINDOW LAYOUT but not the programs inside the panes
# (and its autosave had silently died for ~2 months, so even the layout was
# stale). This script is the reliable path: it reads fleet.manifest and opens one
# tmux window per instance running `bukowski <flags> --restore <name>` from the
# recorded cwd. The engine (since 95a708b) autosaves each session, so --restore
# resumes it and every agent continues its own LLM transcript. The first --join
# re-establishes the federation SSH tunnel; later ones re-plant static peers.
#
# SAFE BY DEFAULT: dry-run unless --go is passed. Idempotent: an instance already
# running (matched by `--restore <name>`) is skipped, so re-running never doubles
# a pane. A manifest cwd that does not exist (e.g. an unmounted drive) is skipped
# with a warning. This script only SPAWNS bukowski; it never kills panes, touches
# systemd user units, or removes any file (secret-keeper material is untouched).
#
# Usage:
#   start-fleet.sh            # dry-run: print what would be launched
#   start-fleet.sh --go       # actually launch the missing instances
#   start-fleet.sh --go azra meddaemon   # only these names
#   BUKOWSKI_FLEET_SESSION=0 start-fleet.sh --go   # target tmux session 0
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="${BUKOWSKI_FLEET_MANIFEST:-$HERE/fleet.manifest}"
BUKOWSKI_BIN="${BUKOWSKI_BIN:-bukowski}"

GO=0
WANT=()
for a in "$@"; do
  case "$a" in
    --go) GO=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    -*) echo "unknown flag: $a" >&2; exit 2 ;;
    *) WANT+=("$a") ;;
  esac
done

[ -r "$MANIFEST" ] || { echo "no manifest at $MANIFEST" >&2; exit 1; }

# Pick a tmux session to hang the windows on: an explicit override, else the
# session this script runs inside, else the first server session.
target_session() {
  if [ -n "${BUKOWSKI_FLEET_SESSION:-}" ]; then echo "$BUKOWSKI_FLEET_SESSION"; return; fi
  if [ -n "${TMUX:-}" ]; then tmux display-message -p '#S' 2>/dev/null && return; fi
  tmux ls -F '#S' 2>/dev/null | head -1
}
SESS="$(target_session)"
if [ -z "$SESS" ]; then
  echo "no tmux session found — start tmux first (or set BUKOWSKI_FLEET_SESSION)" >&2
  [ "$GO" = 1 ] && exit 1
fi

wanted() {  # is $1 in WANT (or WANT empty = all)?
  [ ${#WANT[@]} -eq 0 ] && return 0
  local n; for n in "${WANT[@]}"; do [ "$n" = "$1" ] && return 0; done
  return 1
}

launched=0 skipped=0
while IFS=$'\t' read -r name cwd flags; do
  case "$name" in ''|\#*) continue ;; esac
  wanted "$name" || continue

  if pgrep -af -- "--restore $name" | grep -q "bukowski"; then
    echo "skip  $name — already running"; skipped=$((skipped+1)); continue
  fi
  if [ ! -d "$cwd" ]; then
    echo "skip  $name — cwd missing: $cwd"; skipped=$((skipped+1)); continue
  fi

  cmd="exec $BUKOWSKI_BIN $flags --restore $name"
  if [ "$GO" = 1 ]; then
    tmux new-window -t "$SESS:" -c "$cwd" -n "$name" "$cmd" \
      && { echo "START $name  ($cwd)"; launched=$((launched+1)); } \
      || echo "FAIL  $name — tmux new-window errored" >&2
  else
    echo "WOULD $name  cwd=$cwd  :: $BUKOWSKI_BIN $flags --restore $name"
    launched=$((launched+1))
  fi
done < "$MANIFEST"

echo
if [ "$GO" = 1 ]; then
  echo "launched $launched, skipped $skipped (session $SESS)"
else
  echo "dry-run: $launched would launch, $skipped skipped. Re-run with --go to apply."
fi
