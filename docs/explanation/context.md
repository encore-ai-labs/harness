# Context

Conversation history is an event stream, not memory.

**What the model sees** is `project(messages, cursor)`:

- the project map, including a **skill catalog** (name + one-line description). Bodies load through the `skill` tool so home-directory skills (`~/.agents/skills/serve-sim`) are reachable without dumping manuals into the prefix.

- items with `turn <= compactedThroughTurn` are replaced by one summary message (from native `POST /v1/responses/compact`, plus a local compile into `state.json`)
- `function_call_output` items with `turn <= prunedThroughTurn` become a stub

**What is on disk** is still the full `messages.jsonl`. That is why receipts and rewind can go back further than the live prompt.

Prune only fires when both age (`pruneAfterTurns`) and size (`pruneMinChars`) are met, and only at a turn boundary. Editing the middle of the prompt invalidates Grok's prefix cache from that point on — pruning one tool result per turn would be a speed bug.

Compact at 160k tokens, not 500k. Grok 4.6 bills every token in a request at 2× once the prompt reaches 200k. Cost, not capacity, sets the line.

Durable memory (`update_state`) is the thing that is supposed to survive that cut: facts, decisions with reasons, lessons. The plan is separate and volatile on purpose.
