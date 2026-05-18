#!/usr/bin/env bash
# Require-time smoke. Runs `node multi.js --help` so every top-level
# require() executes and parseArgs() exits cleanly. Catches typos,
# missing exports, circular imports, syntax errors that node -c misses
# (e.g. assertions inside requires).
#
# Pass: --help prints + exits 0 and no JS error keywords in output.

set -u
cd "$(dirname "$0")/../.."

out=$(node multi.js --help 2>&1)
status=$?

if [ "$status" -ne 0 ]; then
  echo "FAIL: --help exited with status $status"
  echo "---- output ----"
  printf '%s\n' "$out"
  exit 1
fi

if printf '%s' "$out" | grep -qE 'TypeError|ReferenceError|SyntaxError|Cannot find module|UnhandledPromiseRejection|at Module\._compile'; then
  echo "FAIL: error keywords detected in --help output"
  echo "---- output ----"
  printf '%s\n' "$out"
  exit 1
fi

echo "OK: require-time smoke passed"
