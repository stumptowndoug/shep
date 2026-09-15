# Shep 0.8.3

## Improvements

- Choose which Claude and Gemini utilization limits appear with independent
  **5h** and **7D** buttons beside each provider in Settings.
- Simplify Antigravity utilization to Gemini; remove the Claude + GPT quota pool
  from the utilization display and settings.
- Keep existing Claude five-hour preferences when upgrading. Gemini starts with
  the seven-day limit shown and the five-hour limit hidden.

## Fixes

- Close a startup timing gap that could delay showing freshly loaded usage.
- Show actionable Claude authorization and rate-limit errors instead of silently
  leaving usage unavailable. Claude uses saved Claude Code credentials; an expired
  credential may require signing in through Claude Code again.
