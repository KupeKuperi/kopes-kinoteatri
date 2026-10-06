#!/usr/bin/env bash
# Picks an iPhone simulator of the newest iOS runtime, writes its UDID to the file $1, then boots it.
# CI starts this in the background: CoreSimulator's start and a first boot take minutes on GitHub's
# Macs, and run meanwhile with the core and app builds.
set -euo pipefail
udid_file="$1"

pick=$(xcrun simctl list devices available -j | jq -r '
  [ .devices | to_entries[] | select(.key | test("[.]iOS-[0-9]")) | .key as $rt
    | .value[] | select(.name | startswith("iPhone"))
    | {udid, name, rt: ($rt | split(".") | last), v: ($rt | [scan("[0-9]+")] | map(tonumber))} ]
  | sort_by(.v) | last // empty | [.udid, .name, .rt] | join("|")')
if [ -z "$pick" ]; then
  xcrun simctl list devices available
  echo "No iPhone simulator available" >&2
  exit 1
fi
IFS='|' read -r udid name runtime <<< "$pick"
echo "Simulator: $name, $runtime ($udid)"
echo "$udid" > "$udid_file"
xcrun simctl boot "$udid"
echo "Booting (simctl boot returned at $(date -u +%H:%M:%S))"
