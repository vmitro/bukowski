#!/usr/bin/env bash
# Regenerate the fleet manifest from ~/.bukowski/boot.log.
#
# boot.log records every bukowski launch (multi.js logs ts/pid/pane/cwd/argv).
# A fleet member is a launch that restores a NAMED session: `--restore <name>`,
# or its aliases `--resume <name>` / `-r <name>` (bootstrap/index.js parseArgs
# folds all three to cliArgs.restore). `--continue` and bare `-r latest` panes
# carry no name — the operator's own panes — and are skipped.
#
# We want the LAST FLEET, not every name ever launched. A boot batch fires its
# panes within seconds of each other, so we keep only names whose newest launch
# falls within WINDOW seconds of the single newest restore launch in the log.
# That drops long-dead one-offs (a renamed pane, an old typo) while keeping the
# two-batch reboot that is one real fleet. Per name, the newest launch wins, so
# its cwd and the flags preceding the restore flag (e.g.
# `--with-tatr-bridge --join vmitro@100.64.0.11`) are exactly what to replay.
#
# Usage: gen-fleet-manifest.sh [boot.log] > fleet.manifest
#   BUKOWSKI_FLEET_WINDOW_SEC=21600 (6h) — how far back from the newest launch a
#   name may be and still count as part of the current fleet.
set -euo pipefail

BOOTLOG="${1:-$HOME/.bukowski/boot.log}"
WINDOW="${BUKOWSKI_FLEET_WINDOW_SEC:-21600}"
[ -r "$BOOTLOG" ] || { echo "no boot.log at $BOOTLOG" >&2; exit 1; }

# newest restore launch (any alias), as an ISO ts → the window anchor.
newest_ts=$(grep -E -- '(--restore|--resume| -r )' "$BOOTLOG" \
  | grep -Ev -- '(--restore|--resume|-r) (latest( |$)|-)' \
  | awk '{print $1}' | sort | tail -1)
[ -n "$newest_ts" ] || { echo "no named restore launches in $BOOTLOG" >&2; exit 1; }
cutoff=$(date -u -d "$newest_ts - $WINDOW seconds" +%Y-%m-%dT%H:%M:%S)

echo "# bukowski fleet manifest — regenerated $(date -Is)"
echo "# source: $BOOTLOG  (window ${WINDOW}s back from $newest_ts)"
echo "# <restore-name>	<cwd>	<flags>   (TAB-separated; start-fleet.sh replays each)"

awk -v cutoff="$cutoff" '
  {
    ts=substr($1,1,19);            # ISO second precision; lexical == chronological
    cwd=""; argv_at=0;
    for (i=1;i<=NF;i++) {
      if ($i ~ /^cwd=/)  cwd=substr($i,5);
      if ($i ~ /^argv=/) argv_at=i;
    }
    if (!argv_at) next;
    restore_at=0;
    for (i=argv_at; i<=NF; i++) {
      tok=$i; sub(/^argv=/,"",tok);
      if (tok=="--restore" || tok=="--resume" || tok=="-r") { restore_at=i; break }
    }
    if (!restore_at) next;                                   # --continue / none
    name=$(restore_at+1);
    if (name=="" || name ~ /^-/ || name=="latest") next;     # unnamed restore
    flags="";
    for (i=argv_at+1; i<restore_at; i++) flags=(flags==""?$i:flags" "$i);
    if (ts >= TS[name]) { TS[name]=ts; CWD[name]=cwd; FLAGS[name]=flags }  # newest wins
  }
  END {
    n=0; for (k in CWD) if (TS[k] >= cutoff) keys[n++]=k;    # within the fleet window
    for (a=0;a<n;a++) for (b=a+1;b<n;b++) if (keys[b]<keys[a]) { t=keys[a];keys[a]=keys[b];keys[b]=t }
    for (a=0;a<n;a++) { k=keys[a]; printf "%s\t%s\t%s\n", k, CWD[k], FLAGS[k] }
  }
' "$BOOTLOG"
