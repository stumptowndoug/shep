# Next release — draft

Version and publication date are pending. These notes describe development work;
packaged upgrade, provider, and long-session verification are still required.

- Preserve project visibility and terminal history during upgrades. Pinned group
  state now survives refreshes. The initial navigation migration pins legacy
  ungrouped projects once; subsequent pin choices are preserved.
- Wait for update installation before offering Restart, and finish agent cleanup
  before quitting or restarting. Clean up ACP adapters when the webview reloads.
- Keep delayed session launches and autostart commands attached to their original
  project. Report project-loading errors with retry instead of showing onboarding.
- Share and bound Git scans, cap diff previews, refresh after index changes, and
  show supported merge-conflict diffs.
- Save configuration atomically with a previous-copy backup. Warn persistently
  when history cannot be saved to disk.
- Bound chat cancellation, handle late updates without duplicate tools, and
  avoid rich rendering for very large responses. Render the latest 50 turns by
  default, with earlier turns and tool details available on demand. Full
  conversation storage remains in memory; longer-session profiling is pending.
- Preserve model/project usage totals, reject stale reporting responses, and
  include archived usage. New archive writes retain session identity and commit
  atomically. Older totals already overwritten by previous versions cannot be
  reconstructed from the database alone.
- Verify managed Antigravity archives and binaries against pinned hashes. Update
  dependencies flagged by the security review.
- Improve keyboard project menus, switcher focus, Select dismissal, and pin
  visibility. Restrict file-editor targets to the project and bound suggestion
  log parsing.
- Include full terminal and ACP agent process trees in memory diagnostics;
  explicitly label WebKit/GPU memory as excluded.
- Require frozen dependencies, complete automated checks, dependency audits, and
  a committed source revision before signing a release.
