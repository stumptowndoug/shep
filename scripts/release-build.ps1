# One-shot Windows release build for Shep — the Windows counterpart of
# release-build.sh.
#
# - Verifies .env is present and loads it
# - Verifies the updater signing key file exists and exports its contents
# - Verifies package.json / tauri.conf.json / Cargo.toml versions match
# - Runs pnpm install, pnpm tauri build
# - Generates/merges latest.json (windows-x86_64 entry)
# - Prints a summary of the resulting artifacts
#
# Authenticode signing is optional: configure bundle.windows
# (certificateThumbprint or signCommand) in tauri.conf.json when a
# certificate is available. Unsigned installers work but trigger SmartScreen.
#
# Usage: pwsh scripts/release-build.ps1  (or powershell -File)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

function Step($msg)  { Write-Host "`n-- $msg" }
function Ok($msg)    { Write-Host "   OK: $msg" }
function Fail($msg)  { Write-Error "ERROR: $msg"; exit 1 }

# -- Step 1: load .env ------------------------------------------------

Step "Loading .env"

if (-not (Test-Path ".env")) {
    Fail ".env not found at repo root. See docs/RELEASING.md for required variables."
}

foreach ($line in Get-Content ".env") {
    if ($line -match '^\s*#' -or $line -match '^\s*$') { continue }
    $name, $value = $line -split '=', 2
    if ($null -ne $value) {
        Set-Item -Path "env:$($name.Trim())" -Value $value.Trim()
    }
}
Ok "loaded .env"

# -- Step 2: updater signing key --------------------------------------

Step "Loading updater signing key"

if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PATH) {
    Fail "TAURI_SIGNING_PRIVATE_KEY_PATH is not set in .env"
}
if (-not (Test-Path $env:TAURI_SIGNING_PRIVATE_KEY_PATH)) {
    Fail "Updater key file not found at: $env:TAURI_SIGNING_PRIVATE_KEY_PATH"
}
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $env:TAURI_SIGNING_PRIVATE_KEY_PATH -Raw
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    Fail "Updater key file is empty"
}
Ok "updater key loaded from $env:TAURI_SIGNING_PRIVATE_KEY_PATH"

# -- Step 3: verify tools ----------------------------------------------

Step "Verifying build tools"

foreach ($tool in @("pnpm", "cargo")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Fail "$tool is not on PATH"
    }
    Ok $tool
}

# -- Step 4: version consistency ---------------------------------------

Step "Verifying version consistency"

$pkgVersion = (Get-Content "package.json" -Raw | ConvertFrom-Json).version
$tauriVersion = (Get-Content "src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json).version
$cargoVersion = (Select-String -Path "src-tauri/Cargo.toml" -Pattern '^version\s*=\s*"([^"]+)"')[0].Matches.Groups[1].Value

if ($pkgVersion -ne $tauriVersion -or $pkgVersion -ne $cargoVersion) {
    Fail "Version mismatch: package.json=$pkgVersion tauri.conf.json=$tauriVersion Cargo.toml=$cargoVersion"
}
$version = $pkgVersion
Ok "all three files agree on v$version"

# -- Step 5: warn on dirty working tree ---------------------------------

Step "Checking working tree"

if (git status --porcelain) {
    Write-Host "   WARNING: working tree is dirty. Release artifacts will include uncommitted changes."
} else {
    Ok "working tree is clean"
}

# -- Step 6: install deps + build ---------------------------------------

Step "pnpm install"
pnpm install
if ($LASTEXITCODE -ne 0) { Fail "pnpm install failed" }

Step "pnpm tauri build"
pnpm tauri build
if ($LASTEXITCODE -ne 0) { Fail "pnpm tauri build failed" }

# -- Step 7: latest.json ------------------------------------------------

Step "Generating latest.json"

$setupExe = "src-tauri/target/release/bundle/nsis/shep_${version}_x64-setup.exe"
$setupSig = "$setupExe.sig"

if (-not (Test-Path $setupSig)) {
    Fail "Signature file not found at $setupSig — was TAURI_SIGNING_PRIVATE_KEY set during the build?"
}

$platforms = [ordered]@{}
# Merge entries from an existing same-version latest.json (mac lane output).
if ((Test-Path "latest.json")) {
    $existing = Get-Content "latest.json" -Raw | ConvertFrom-Json
    if ($existing.version -eq $version) {
        foreach ($prop in $existing.platforms.PSObject.Properties) {
            $platforms[$prop.Name] = $prop.Value
        }
    }
}
$platforms["windows-x86_64"] = [ordered]@{
    signature = (Get-Content $setupSig -Raw).Trim()
    url       = "https://github.com/stumptowndoug/shep/releases/download/v$version/shep_${version}_x64-setup.exe"
}

[ordered]@{
    version   = $version
    notes     = "See release notes on GitHub"
    pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = $platforms
} | ConvertTo-Json -Depth 5 | Set-Content -Path "latest.json" -Encoding utf8

Ok "latest.json includes: $($platforms.Keys -join ', ')"

# -- Step 8: summary ------------------------------------------------------

Write-Host ""
Write-Host "-- Release build complete: v$version"
Write-Host ""
Write-Host "   Installer:  $setupExe"
Write-Host "   Signature:  $setupSig"
Write-Host "   Metadata:   latest.json"
Write-Host ""
Write-Host "Next steps:"
Write-Host "   1. Smoke test the installer"
Write-Host "   2. Coordinate with the macOS lane so one release carries both platforms"
Write-Host "   3. gh release upload v$version $setupExe $setupSig latest.json"
Write-Host ""
