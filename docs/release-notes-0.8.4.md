# Shep 0.8.4

## Performance

- Stop recurring to-do refreshes from scanning every project, and perform requested
  to-do discovery away from the application UI thread.
- Cache resolved Cursor session metadata paths instead of repeatedly searching the
  full Cursor chat history.
- Ignore high-churn build, coverage, cache, and virtual-environment directories in
  repository change notifications.
- Release WebGL renderer resources when terminals are hidden while preserving their
  session output and scrollback.

## Improvements

- Refresh project to-dos when the panel opens or when a relevant to-do file changes.
- Show the terminal scrollback setting's memory tradeoff in Settings.
