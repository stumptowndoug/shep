# Releasing Shep

Shep ships for macOS (`.dmg`) and Windows (NSIS `setup.exe`). Both platforms
share one updater endpoint — `releases/latest/download/latest.json` — so a
release must carry a single `latest.json` containing an entry for every
platform being shipped.

## Prerequisites (both lanes)

- Node.js 20+, `pnpm`, Rust via `rustup`
- A `.env` file at the repo root (never committed) with at minimum:

```bash
# Updater artifact signing (same minisign key on every platform)
TAURI_SIGNING_PRIVATE_KEY_PATH=/absolute/path/to/shep-updater.key
# Only if the key is password protected:
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=...
```

The updater public key lives in `src-tauri/tauri.conf.json` under
`plugins.updater.pubkey`; the same private key signs macOS and Windows
artifacts.

## macOS lane

Additional `.env` variables:

```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: ... (TEAMID)"
APPLE_ID=you@example.com
APPLE_PASSWORD=app-specific-password
APPLE_TEAM_ID=TEAMID
```

The Developer ID certificate must be installed in the login Keychain
(`DeveloperIDG2CA.cer` at the repo root is Apple's intermediate CA, needed to
complete the trust chain when installing the signing cert).

Run:

```bash
./scripts/release-build.sh
```

Produces: `.dmg`, `shep.app.tar.gz(.sig)`, and `latest.json` with a
`darwin-aarch64` entry.

## Windows lane

Run on a Windows machine with the MSVC toolchain (Visual Studio Build Tools
2022, "Desktop development with C++"):

```powershell
pwsh scripts/release-build.ps1
```

Produces: `shep_X.Y.Z_x64-setup.exe(.sig)` under
`src-tauri/target/release/bundle/nsis/` and `latest.json` with a
`windows-x86_64` entry.

Authenticode signing is optional but recommended (unsigned installers trigger
SmartScreen). Configure `bundle.windows.certificateThumbprint` or a
`signCommand` (e.g. Azure Trusted Signing) in `tauri.conf.json` /
`tauri.windows.conf.json` when a certificate is available.

## Merging the lanes into one release

Both `generate-update-json.sh` and `release-build.ps1` merge with an existing
same-version `latest.json` instead of overwriting it. To ship both platforms:

1. Run the macOS lane; keep its `latest.json`.
2. Copy that `latest.json` to the repo root on the Windows machine and run the
   Windows lane (or vice versa). The script adds its platform entry alongside
   the existing one.
3. Verify: `jq '.platforms | keys' latest.json` →
   `["darwin-aarch64", "windows-x86_64"]`.

Then publish once:

```bash
git tag vX.Y.Z && git push origin main vX.Y.Z
gh release create vX.Y.Z \
  <dmg> <shep.app.tar.gz> <shep.app.tar.gz.sig> \
  <shep_X.Y.Z_x64-setup.exe> <shep_X.Y.Z_x64-setup.exe.sig> \
  latest.json
```

Shipping a release with only one platform's entry in `latest.json` silently
disables auto-update on the other platform — always merge before uploading.

## Version bumps

`./scripts/bump-version.sh X.Y.Z` updates `package.json`,
`src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` and commits the bump.
On Windows, run it from Git Bash with `jq` installed
(`winget install jqlang.jq`).
