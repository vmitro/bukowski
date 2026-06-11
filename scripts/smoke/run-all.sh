#!/usr/bin/env bash
# Run all smoke tests in order. Fast checks first so we fail before
# paying the cost of slow PTY-based ones.

set -u
here="$(cd "$(dirname "$0")" && pwd)"

scripts=(
  "$here/01-require.sh"
  "$here/02-boot.js"
  "$here/10-local-alias-fipa.js"
  "$here/11-events.js"
  "$here/03-federation.js"
  "$here/09-external-agent-federation.js"
  "$here/05-channels.js"
  "$here/06-dashboard-store.js"
  "$here/07-dashboard.js"
  "$here/08-dashboard-pane.js"
)

failed=0
for s in "${scripts[@]}"; do
  echo "==> $(basename "$s")"
  if ! "$s"; then
    echo "==> FAILED: $(basename "$s")"
    failed=$((failed + 1))
  fi
  echo
done

if [ "$failed" -gt 0 ]; then
  echo "$failed smoke test(s) failed"
  exit 1
fi
echo "all smoke tests passed"
