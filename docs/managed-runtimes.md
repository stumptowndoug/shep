# Managed runtime verification

Shep pins the Antigravity ACP runtime to version 1.3.0 and to SHA-256 hashes
compiled into `src-tauri/src/acp_runtime.rs`. It checks the ZIP before extraction
and checks both installed files before returning a launch command. Invalid or
incomplete existing installations can be repaired using the installer. Hashing
runs off the UI thread.

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
