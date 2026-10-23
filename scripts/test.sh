#!/usr/bin/env bash
set -euo pipefail

echo "[test] node syntax check"
find src -name '*.js' -print0 | xargs -0 -n1 node --check

echo "[test] unit tests"
node --test tests/*.test.js

echo "[test] done"
