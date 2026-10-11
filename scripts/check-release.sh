#!/usr/bin/env bash
# Run the reproducible checks required before signing a release. No signing keys.
set -euo pipefail
cd "$(dirname "$0")/.."

for tool in pnpm cargo cargo-audit; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'Missing required tool: %s\n' "$tool" >&2; exit 1; }
done

pnpm install --frozen-lockfile
pnpm build
pnpm test:unit
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
pnpm exec playwright test --workers=4
pnpm audit --audit-level=moderate
cargo audit --file src-tauri/Cargo.lock
