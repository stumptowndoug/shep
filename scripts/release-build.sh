#!/usr/bin/env bash
#
# One-shot release build for Shep.
#
# - Verifies .env is present and every required signing/notarization var is set
# - Verifies the Developer ID certificate is actually installed in Keychain
# - Verifies the updater signing key file exists and exports its contents
# - Verifies package.json / tauri.conf.json / Cargo.toml versions match
# - Runs pnpm install, pnpm tauri build, post-build-dmg.sh, final DMG notarization,
#   and generate-update-json.sh
# - Prints a summary of the resulting artifacts
#
# Usage: ./scripts/release-build.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

# ── Pre-flight output helpers ───────────────────────────────────────
# Plain text, no color, so this is readable in CI logs too.

step()  { printf -- "\n── %s\n" "$1"; }
ok()    { printf -- "   OK: %s\n" "$1"; }
fail()  { printf -- "\nERROR: %s\n" "$1" >&2; exit 1; }

# ── Step 1: verify .env and load signing env vars ───────────────────

step "Loading .env"

if [ ! -f .env ]; then
  fail ".env not found at repo root. See docs/RELEASING.md for required variables."
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

ok "sourced .env"

# ── Step 2: verify every required env var is set ────────────────────

step "Verifying signing environment"

require_var() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    fail "$name is not set in .env"
  fi
  ok "$name is set"
}

require_var APPLE_SIGNING_IDENTITY
require_var APPLE_ID
require_var APPLE_PASSWORD
require_var APPLE_TEAM_ID
require_var TAURI_SIGNING_PRIVATE_KEY_PATH

# ── Step 3: verify the Developer ID cert is actually in Keychain ────
#
# Catches the common "env vars set but cert was regenerated and never
# reinstalled" failure mode where tauri would otherwise fail partway
# through the build with a cryptic codesign error.

step "Verifying Developer ID certificate in Keychain"

if ! command -v security >/dev/null 2>&1; then
  fail "'security' command not available (expected on macOS)"
fi

KEYCHAIN_IDENTITIES=$(security find-identity -v -p codesigning 2>/dev/null || true)
if ! printf "%s" "$KEYCHAIN_IDENTITIES" | grep -Fq "$APPLE_SIGNING_IDENTITY"; then
  printf "\n%s\n" "$KEYCHAIN_IDENTITIES" >&2
  fail "Signing identity '$APPLE_SIGNING_IDENTITY' not found in Keychain. Recreate it in Xcode → Settings → Accounts → Manage Certificates."
fi

ok "$APPLE_SIGNING_IDENTITY"

# ── Step 4: verify updater signing key file + export contents ───────

step "Loading updater signing key"

if [ ! -f "$TAURI_SIGNING_PRIVATE_KEY_PATH" ]; then
  fail "Updater key file not found at: $TAURI_SIGNING_PRIVATE_KEY_PATH"
fi

export TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY="$(cat "$TAURI_SIGNING_PRIVATE_KEY_PATH")"

if [ -z "$TAURI_SIGNING_PRIVATE_KEY" ]; then
  fail "Updater key file at $TAURI_SIGNING_PRIVATE_KEY_PATH is empty"
fi

ok "updater key loaded from $TAURI_SIGNING_PRIVATE_KEY_PATH"

if [ -n "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]; then
  ok "updater key password is set"
else
  ok "updater key password is not set (this is fine if the key has no password)"
fi

# ── Step 5: verify required tools are on PATH ───────────────────────

step "Verifying build tools"

for tool in pnpm jq hdiutil codesign; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    fail "$tool is not on PATH"
  fi
  ok "$tool"
done

# ── Step 6: verify all three version files agree ────────────────────

step "Verifying version consistency"

PKG_VERSION=$(jq -r .version package.json)
TAURI_VERSION=$(jq -r .version src-tauri/tauri.conf.json)
CARGO_VERSION=$(grep -E '^version\s*=' src-tauri/Cargo.toml | head -1 | sed -E 's/version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/')

if [ "$PKG_VERSION" != "$TAURI_VERSION" ] || [ "$PKG_VERSION" != "$CARGO_VERSION" ]; then
  fail "Version mismatch: package.json=$PKG_VERSION tauri.conf.json=$TAURI_VERSION Cargo.toml=$CARGO_VERSION"
fi

VERSION="$PKG_VERSION"
ok "all three files agree on v$VERSION"

# ── Step 7: warn on dirty working tree (don't block) ────────────────

step "Checking working tree"

if [ -n "$(git status --porcelain)" ]; then
  printf "   WARNING: working tree is dirty. Continuing anyway, but release artifacts\n"
  printf "            will include uncommitted changes.\n"
  git status --short | sed 's/^/            /'
else
  ok "working tree is clean"
fi

# ── Step 8: install deps + build + post-build + updater metadata ────

step "pnpm install"
pnpm install

step "pnpm tauri build (signs + notarizes — can take several minutes)"
pnpm tauri build

step "Patching DMG (post-build-dmg.sh)"
./scripts/post-build-dmg.sh

FINAL_DMG="src-tauri/target/release/bundle/dmg/shep_${VERSION}_aarch64.dmg"

step "Notarizing final DMG"
xcrun notarytool submit "$FINAL_DMG" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait

step "Stapling final DMG"
xcrun stapler staple "$FINAL_DMG"

step "Generating latest.json (generate-update-json.sh)"
bash scripts/generate-update-json.sh

# ── Step 9: summary ─────────────────────────────────────────────────

DMG_PATH="src-tauri/target/release/bundle/dmg/shep_${VERSION}_aarch64.dmg"
UPDATER_TARBALL="src-tauri/target/release/bundle/macos/shep.app.tar.gz"
UPDATER_SIG="src-tauri/target/release/bundle/macos/shep.app.tar.gz.sig"

printf "\n"
printf "── Release build complete: v%s\n" "$VERSION"
printf "\n"
printf "   DMG:          %s\n" "$DMG_PATH"
printf "   Updater:      %s\n" "$UPDATER_TARBALL"
printf "   Signature:    %s\n" "$UPDATER_SIG"
printf "   Metadata:     latest.json\n"
printf "\n"
printf "Next steps:\n"
printf "   1. Smoke test the built .app (or install from the .dmg)\n"
printf "   2. git tag v%s && git push origin main && git push origin v%s\n" "$VERSION" "$VERSION"
printf "   3. gh release create v%s <dmg> <updater-tarball> <updater-sig> latest.json\n" "$VERSION"
printf "\n"
