#!/usr/bin/env bash
# Check only: never discard files or alter the index.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! git diff --quiet || ! git diff --cached --quiet; then
  printf 'Release builds require committed tracked changes.\n' >&2
  exit 1
fi

# Local agent configuration and design documents are not release inputs. Unknown
# source, assets, build scripts, and tests must not slip into a supposedly clean build.
untracked_inputs=$(git ls-files --others --exclude-standard -- src src-tauri assets public scripts tests index.html package.json pnpm-lock.yaml 'tsconfig*.json' 'vite.config.*' 'playwright.config.*')
if [ -n "$untracked_inputs" ]; then
  printf 'Untracked release inputs must be committed or moved out of the build:\n%s\n' "$untracked_inputs" >&2
  exit 1
fi
git rev-parse HEAD
