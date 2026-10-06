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
for target in "${targets[@]}"; do
  echo "== kino-core ($mode) for $target"
  # The library only (not the smoke CLI). The note "native-static-libs" lists the system libraries
  # the static library needs when an app links it (printed when the core is compiled).
  # shellcheck disable=SC2086 # $features is a list of flags
  cargo rustc -p kino-core --lib --release --target "$target" $features -- --print native-static-libs
done

target_dir="${CARGO_TARGET_DIR:-$ios/target}"
out="$app/Frameworks/KinoCore.xcframework"
rm -rf "$out"
xcodebuild -create-xcframework \
  -library "$target_dir/aarch64-apple-ios/release/libkino_core.a" -headers "$ios/core/include" \
  -library "$target_dir/aarch64-apple-ios-sim/release/libkino_core.a" -headers "$ios/core/include" \
  -output "$out"
ls -l "$target_dir"/aarch64-apple-ios*/release/libkino_core.a
echo "Wrote $out ($mode core)"
