# Managed runtime verification

Antigravity's chat runtime comes from Google's versioned HTTPS downloads, not
npm. Shep only downloads it after the user chooses to set up Antigravity chat.

## Updates

At launch, at most once a day, Shep reads Antigravity's
[ACP registry entry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json),
but only for users who already have the runtime. It installs a newer release
when the registry's download is exactly Google's versioned URL for that
release, both extracted binaries satisfy Google's Developer ID requirement
(`codesign --verify --strict`, Apple Developer ID chain, team `EQHXZ8M8AV`),
and the runtime answers ACP `initialize`. Each release lives in its own
`<version>-<arch>` folder. Older ones are removed at the next launch, before any
chat can be using them. A signed release's ZIP is listed and extracted before
its binaries can be checked, so Shep extracts only the two expected entries,
without trusting paths or modes in the archive.

A first install also takes the registry's release. If that fails, Shep installs
the fallback release below, checked against pinned hashes instead.

## Fallback release

Shep pins the fallback Antigravity ACP runtime to version 1.3.0 and to SHA-256
hashes compiled into `src-tauri/src/acp_runtime.rs`. It checks the ZIP before
extraction and checks both installed files before returning a launch command.
Invalid or incomplete existing installations can be repaired using the
installer. Hashing runs off the UI thread.

The pins were established on 2026-10-11 from the versioned Google HTTPS downloads
listed in the [ACP registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json):

| Architecture | Archive SHA-256 |
| --- | --- |
| [arm64](https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-arm64.zip) | `7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88` |
| [x86_64](https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-x86_64.zip) | `bb23956b89984bf5d354af2c3725e6c57f0cc1b7228e77a0e91c9c2bc1d47646` |

These are hashes computed from those downloads, not publisher-provided checksum
files. Before pinning, `codesign --verify --strict` passed for both binaries in
both archives. Their verified signing identity was Developer ID Application:
Google LLC, team `EQHXZ8M8AV`, with an Apple Root CA chain. The binaries were not
executed during this verification.

When updating the runtime, download both supported archives from the registry's
versioned Google URLs, verify the signatures and expected team, inspect the ZIP
entries, and update the version, archive hashes, and both extracted-file hashes
together. Do not automatically trust a checksum fetched alongside a runtime, or
replace a pin just to make a changed download pass. Existing pins deliberately
reject a changed archive at the same versioned URL.

## npm chat adapters

The Claude, Codex, Pi and Muse chat adapters (`ADAPTERS` in
`src-tauri/src/acp_npm.rs`) are not pinned. Shep installs each one with the
user's npm into `shep/acp/npm/<id>/<version>` under the application data folder,
and its copy runs ahead of any copy on the user's PATH.

At launch, at most once a day, Shep updates each adapter the user has set up,
meaning Shep has a copy or one is on PATH. It takes the newest release that
npm's `latest` tag allows and that has been out for at least three days, so a
broken or hijacked release is usually pulled before Shep installs it. A new
copy is kept only if it starts and answers ACP `initialize`; otherwise chat
stays on the copy it has. The next launch removes all but the newest copy, since
no chat can be using the others yet. Each adapter's `fallback` version is
installed only when npm can't list releases.

`cargo test -- --ignored installs_working_adapters_from_npm` looks up each
adapter's releases and installs its fallback version.
