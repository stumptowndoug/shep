# Shep 0.11.2

## Improvements

- **The agent's notes stay in the chat.** What the agent says while it works —
  what it's about to look at, what it found — now stays in the conversation in
  the order it was written, instead of being folded away with its tool calls.
  Each stretch of thinking and tool calls between those notes folds into its own
  row, with its own step and edit counts. The newest row shows what the agent is
  doing right now; a row that was only thinking reads "Thought".

## Fixes

- **Answers no longer disappear into the work row.** If an agent wrote its answer
  and then ran one more tool, the whole answer used to fold away with its work.
