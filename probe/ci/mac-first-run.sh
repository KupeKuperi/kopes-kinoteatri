#!/usr/bin/env bash
# CI check of the packaged Mac app on a clean machine (no moviebox-tui, no player): the first-run
# screen, installing the engine and VLC from the app's own buttons, Discover, a search, a title and
# playing it, switching source, Live TV; then phone access: a "phone" (probe/phone-test.mjs) watches
# a title through the app, and the computer still plays through the engine's player stand-in.
# Screenshots, the step log and the app's and engine's logs land in probe/out/ci/. Fails if the
# engine never got ready or nothing ever played.
set -uo pipefail
cd "$(dirname "$0")/../.."
out=probe/out/ci
mkdir -p "$out"

app=$(ls -d dist/mac-arm64/*.app | head -1)
echo "Testing $app"
userdata="${RUNNER_TEMP:-/tmp}/kino-userdata"
# Phone access listens on this machine only (as a real phone would reach it over Wi-Fi).
KK_PHONE_HOST=127.0.0.1 "$app/Contents/MacOS/KopesKinoteatri" --remote-debugging-port=9333 --user-data-dir="$userdata" > "$out/app.log" 2>&1 &
pid=$!
for _ in $(seq 1 60); do curl -s http://127.0.0.1:9333/json > /dev/null && break; sleep 1; done

# Players started by the test are noted (their arguments show the subtitle file) and closed at
# once: nobody watches on a CI machine.
( while kill -0 "$pid" 2> /dev/null; do
    ps -axo args= | grep -i "[V]LC.app" >> "$out/players.txt" && pkill -x VLC 2> /dev/null
    sleep 2
  done ) &

node probe/cdp.mjs probe/ci/first-run.json 2>&1 | tee "$out/steps.log"

# Phone access: turn it on, watch on the "phone", then play on the computer through the stand-in.
node probe/cdp.mjs probe/ci/phone-on.json 2>&1 | tee -a "$out/steps.log"
key=$(node -p "require('$userdata/gui-settings.json').phone.key" 2> /dev/null)
port=$(node -p "require('$userdata/gui-settings.json').phone.port" 2> /dev/null)
node probe/phone-test.mjs "$port" "$key" 2>&1 | tee "$out/phone.log"
node probe/cdp.mjs probe/ci/phone-desktop-play.json 2>&1 | tee -a "$out/steps.log"

kill "$pid" 2> /dev/null
sleep 3
kill -9 "$pid" 2> /dev/null
pkill -x VLC 2> /dev/null
logs="$HOME/Library/Application Support/moviebox-tui/logs"
cp -R "$logs" "$out/engine-logs" 2> /dev/null || true
ls -la "$HOME/.local/bin" > "$out/engine-folder.txt" 2>&1 || true
launches=$(cat "$logs"/*.log 2> /dev/null | grep -c "launching player" || true)
echo "Players launched: $launches" | tee -a "$out/steps.log"
echo "Player starts with a subtitle file: $(grep -c -- '--sub-file' "$out/players.txt" 2> /dev/null || echo 0)" | tee -a "$out/steps.log"

cp -R "$userdata/phone" "$out/phone-stand-ins" 2> /dev/null || true
if grep -q "TIMEOUT" "$out/steps.log"; then echo "::warning::Some first-run steps timed out; see the mac-first-run artifact."; fi
if ! grep -q "^.* DONE$" "$out/phone.log"; then echo "::warning::The phone test did not finish; see phone.log in the mac-first-run artifact."; fi
grep -q "ENGINE READY" "$out/steps.log" && [ "${launches:-0}" -ge 1 ]
