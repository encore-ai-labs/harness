# Agent loop

`src/agent/loop.ts` is the only orchestrator. CLI parses argv and prints; it does not own a second loop.

Walk of `harness run "change n to 2"` against the fake provider in `test/loop.test.ts`:

1. **boot** — load config, create a session directory, hydrate an empty trace, snapshot an empty checkpoint so rewind-to-start works, build the project map once.
2. **user message** — appended to `messages.jsonl` with `meta.turn`.
3. **contract** — skipped in chat/`--contract never`. On `run` with `auto`, the helper model drafts `{ goal, doneWhen, checks }` on a fresh context. That call is billed to the session and **not** appended to the worker transcript.
4. **instructions** — stable: identity, mode, tools, gates, map, instruction files, contract. This prefix should be identical across turns so Grok's prompt cache hits.
5. **reminder** — omitted unless there is workspace drift, or history was compacted and plan/state must be re-injected. Sent as `role: developer` so Grok does not treat it as the user talking. Budget lives in the spinner and `/cost`, not here. Not persisted. If you put this in `instructions`, every turn busts the cache.
6. **complete** — stream text to the TTY on the first delta. Function calls arrive whole; a read-safe call is dispatched as soon as its item is done (`onItem`), overlapping the rest of the stream.
7. **batch** — wait for in-flight reads, record observed paths, then serialize writes. `howBeforeMutate` and `planBeforeWrite` run **after** the reads in the same batch, so `read` + `write` of the same file in one response is legal.
8. **checkpoint** — if `checkpoints.dirty()` is true, snapshot the shadow git and refresh the map.
9. **stop** — no more calls. For `run`, if files changed, contract checks and known `test`/`typecheck` commands run through the **same gateway** with synthetic `call_id`s (`verify-1`, …). Then the verifier model sees contract + capped diff + check tails + last claim. It never sees the worker history. Reject → at most two repair rounds. Inconclusive is not a pass.
10. **receipt** — fold the trace into `receipt.md`.

Budgets (turns, USD, minutes) and the repeat detector can escalate out of the loop. Ctrl-C aborts the current `fetch` and in-flight bash.
