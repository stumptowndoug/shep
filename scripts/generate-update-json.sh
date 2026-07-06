#!/usr/bin/env bash
#
# Generates latest.json for the Tauri updater plugin.
# Run after `pnpm tauri build` with TAURI_SIGNING_PRIVATE_KEY set.
#
# Emits a platform entry for every signed update artifact found locally
# (macOS app.tar.gz, Windows NSIS setup.exe) and merges with an existing
# same-version latest.json, so the mac and Windows release lanes can run on
# separate machines without clobbering each other's entries.
#
# Usage: bash scripts/generate-update-json.sh
#
set -euo pipefail

VERSION=$(jq -r .version src-tauri/tauri.conf.json)
PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
RELEASE_BASE="https://github.com/stumptowndoug/shep/releases/download/v${VERSION}"

MAC_SIG="src-tauri/target/release/bundle/macos/shep.app.tar.gz.sig"
WIN_SIG="src-tauri/target/release/bundle/nsis/shep_${VERSION}_x64-setup.exe.sig"

PLATFORMS="{}"

if [ -f "$MAC_SIG" ]; then
  PLATFORMS=$(jq --arg sig "$(cat "$MAC_SIG")" --arg url "${RELEASE_BASE}/shep.app.tar.gz" \
    '. + {"darwin-aarch64": {"signature": $sig, "url": $url}}' <<<"$PLATFORMS")
fi

if [ -f "$WIN_SIG" ]; then
  PLATFORMS=$(jq --arg sig "$(cat "$WIN_SIG")" --arg url "${RELEASE_BASE}/shep_${VERSION}_x64-setup.exe" \
    '. + {"windows-x86_64": {"signature": $sig, "url": $url}}' <<<"$PLATFORMS")
fi

if [ "$PLATFORMS" = "{}" ]; then
  echo "Error: no signed update artifacts found."
  echo "Expected ${MAC_SIG} and/or ${WIN_SIG}."
  echo "Make sure TAURI_SIGNING_PRIVATE_KEY is set before building."
  exit 1
fi

# Merge with an existing latest.json from the other platform's lane when it
# targets the same version; entries generated in this run win.
if [ -f latest.json ] && [ "$(jq -r .version latest.json)" = "$VERSION" ]; then
  PLATFORMS=$(jq -s '.[0] + .[1]' <(jq .platforms latest.json) <(printf "%s" "$PLATFORMS"))
fi

jq -n --arg version "$VERSION" --arg pub_date "$PUB_DATE" --argjson platforms "$PLATFORMS" \
  '{version: $version, notes: "See release notes on GitHub", pub_date: $pub_date, platforms: $platforms}' \
  > latest.json

echo "Generated latest.json for v${VERSION} ($(jq -r '.platforms | keys | join(", ")' latest.json))"
