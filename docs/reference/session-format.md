# Session format

A session is a directory `.harness/sessions/<id>/`.

## meta.json

id, cwd, model, mode, status, contract, usage, costUsd, turns, checkpoints[], title, `context` (the ContextCursor).

## messages.jsonl

One Responses **item** per line: `message`, `function_call`, `function_call_output`, `reasoning`. Append-only. Prune and compact do **not** rewrite this file; they advance `meta.context` and `project(items, cursor)` decides what the model sees.

`replaceMessages` is only for rewind (the old file is kept as `messages.N.jsonl`).

Harness-only `meta` on an item (`turn`, `pruned`, `kind`) is stripped by `toWire` before the API.

## trace.jsonl

Append-only events: `session.start`, `model.request`, `model.response` (includes ttftMs, cachedFraction, toolMs), `tool.proposed`, `tool.decision`, `tool.result`, `policy.blocked`, `checkpoint`, `verify.check`, `verify.verdict`, `receipt`, …

The receipt is a pure fold over this file.

## Cursor

```
{ compactedThroughTurn, summary, prunedThroughTurn, compactions, prunedChars }
```

Cuts happen at turn boundaries so call/output pairs stay intact.
