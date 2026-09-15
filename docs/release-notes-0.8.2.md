# Shep 0.8.2

## Fixes

- Restore Antigravity subscription usage with the signed-in CLI's native usage
  report. Gemini and Claude/GPT weekly and five-hour limits now work with current
  `agy` releases, without requiring an interactive session to stay open.
- Prevent stale text in the terminal input field from being replayed while
  typing. Preserve active input composition, accents, paste, and keyboard shortcuts.

## Validation

The input fix has a reproducible browser regression test in WebKit and Chromium.
Everyday use of the updated app remains the final check for the reported
intermittent typing symptom. Antigravity CLI usage was verified with an existing
authenticated account. No additional API key is required.
