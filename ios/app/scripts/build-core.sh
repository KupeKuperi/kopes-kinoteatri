#!/usr/bin/env bash
# Builds the Rust core (ios/core) for the iPhone and the iOS Simulator (Apple Silicon Macs) and packs
# it as ios/app/Frameworks/KinoCore.xcframework, which the Xcode project links. Needs a Mac (CI: the
# macOS runners of .github/workflows/ios.yml).
#
#   CORE_FEATURES  cargo feature flags. Unset: "--no-default-features", the stub (canned titles,
#                  Apple's HLS test stream). Set but empty (CORE_FEATURES=""): the real engine.
set -euo pipefail

app="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ios="$(dirname "$app")"
features="${CORE_FEATURES---no-default-features}"
case " $features " in
  *" --no-default-features "*) mode=stub ;;
  *) mode=engine ;;
esac
targets=(aarch64-apple-ios aarch64-apple-ios-sim)
# Same minimum iOS as the app (project.yml), for the Rust code and the C code of its crates.
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-16.0}"

rustup target add "${targets[@]}"

cd "$ios"
echo "== kino-core ($mode) for ${targets[*]}"
# The library only (not the smoke CLI), both targets in one go: the release profile compiles the
# engine on one core per target, so the two run side by side. The system libraries an app must link
# for the library are in project.yml; to list them again:
#   cargo rustc -p kino-core --lib --release --target aarch64-apple-ios -- --print native-static-libs
# shellcheck disable=SC2086 # $features is a list of flags
cargo build -p kino-core --lib --release $(printf -- '--target %s ' "${targets[@]}") $features

target_dir="${CARGO_TARGET_DIR:-$ios/target}"
out="$app/Frameworks/KinoCore.xcframework"
rm -rf "$out"
xcodebuild -create-xcframework \
  -library "$target_dir/aarch64-apple-ios/release/libkino_core.a" -headers "$ios/core/include" \
  -library "$target_dir/aarch64-apple-ios-sim/release/libkino_core.a" -headers "$ios/core/include" \
  -output "$out"
ls -l "$target_dir"/aarch64-apple-ios*/release/libkino_core.a
echo "Wrote $out ($mode core)"
