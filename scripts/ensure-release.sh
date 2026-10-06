#!/usr/bin/env bash
# Creates the GitHub release for tag $1 (version $2) unless it exists. Both build jobs call it; if
# they race, the second create fails and the release made by the first is used.
set -euo pipefail
tag=$1
version=$2
gh release view "$tag" > /dev/null 2>&1 && exit 0
gh release create "$tag" --title "Kope's Kinoteatri $version" --notes-file scripts/release-notes.md || gh release view "$tag" > /dev/null
