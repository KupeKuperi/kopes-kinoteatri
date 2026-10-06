#!/usr/bin/env bash
# CI check of the packaged Mac app on a clean machine (no moviebox-tui yet): the first-run screen,
# installing the engine from it, Discover, a search and a title. Screenshots, the step log, the
# app's and the engine's logs land in probe/out/ci/. Fails only if the engine never got ready.
set -uo pipefail
cd "$(dirname "$0")/../.."
out=probe/out/ci
mkdir -p "$out"

app=$(ls -d dist/mac-arm64/*.app | head -1)
echo "Testing $app"
"$app/Contents/MacOS/KopesKinoteatri" --remote-debugging-port=9333 --user-data-dir="${RUNNER_TEMP:-/tmp}/kino-userdata" > "$out/app.log" 2>&1 &
pid=$!
for _ in $(seq 1 60); do curl -s http://127.0.0.1:9333/json > /dev/null && break; sleep 1; done

node probe/cdp.mjs probe/ci/first-run.json 2>&1 | tee "$out/steps.log"

kill "$pid" 2> /dev/null
sleep 3
kill -9 "$pid" 2> /dev/null
cp -R "$HOME/Library/Application Support/moviebox-tui/logs" "$out/engine-logs" 2> /dev/null || true
ls -la "$HOME/.local/bin" > "$out/engine-folder.txt" 2>&1 || true

if grep -q "TIMEOUT" "$out/steps.log"; then echo "::warning::Some first-run steps timed out; see the mac-first-run artifact."; fi
grep -q "ENGINE READY" "$out/steps.log"
