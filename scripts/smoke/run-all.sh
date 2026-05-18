#!/usr/bin/env bash
# Run all smoke tests in order. Fast checks first so we fail before
# paying the cost of slow PTY-based ones.

set -u
here="$(cd "$(dirname "$0")" && pwd)"

scripts=(
  "$here/01-require.sh"
  "$here/02-boot.js"
  "$here/03-federation.js"
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
