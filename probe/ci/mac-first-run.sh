#!/usr/bin/env bash
# CI check of the packaged Mac app on a clean machine (no moviebox-tui, no player): the first-run
# screen, installing the engine and VLC from the app's own buttons, Discover, a search, a title and
# playing it, switching source, Live TV. Screenshots, the step log and the app's and engine's logs
# land in probe/out/ci/. Fails if the engine never got ready or nothing ever played.
set -uo pipefail
cd "$(dirname "$0")/../.."
out=probe/out/ci
mkdir -p "$out"

app=$(ls -d dist/mac-arm64/*.app | head -1)
echo "Testing $app"
"$app/Contents/MacOS/KopesKinoteatri" --remote-debugging-port=9333 --user-data-dir="${RUNNER_TEMP:-/tmp}/kino-userdata" > "$out/app.log" 2>&1 &
pid=$!
for _ in $(seq 1 60); do curl -s http://127.0.0.1:9333/json > /dev/null && break; sleep 1; done

# Players started by the test are closed as soon as they appear (nobody watches on a CI machine).
( while kill -0 "$pid" 2> /dev/null; do pkill -x VLC 2> /dev/null; sleep 3; done ) &

node probe/cdp.mjs probe/ci/first-run.json 2>&1 | tee "$out/steps.log"

kill "$pid" 2> /dev/null
sleep 3
kill -9 "$pid" 2> /dev/null
pkill -x VLC 2> /dev/null
logs="$HOME/Library/Application Support/moviebox-tui/logs"
cp -R "$logs" "$out/engine-logs" 2> /dev/null || true
ls -la "$HOME/.local/bin" > "$out/engine-folder.txt" 2>&1 || true
launches=$(cat "$logs"/*.log 2> /dev/null | grep -c "launching player" || true)
echo "Players launched: $launches" | tee -a "$out/steps.log"

if grep -q "TIMEOUT" "$out/steps.log"; then echo "::warning::Some first-run steps timed out; see the mac-first-run artifact."; fi
grep -q "ENGINE READY" "$out/steps.log" && [ "${launches:-0}" -ge 1 ]
