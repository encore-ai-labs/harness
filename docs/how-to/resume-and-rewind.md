# Resume and rewind

## Resume

```bash
harness sessions
harness resume                 # latest
harness resume 20260916-...    # named
```

Resume hydrates `trace.jsonl` (so receipts still work) and seals dangling tool calls: if the process died after a `function_call` and before the output, you get a synthetic failure. The write is **not** replayed.

## Rewind

Every turn that changed files takes a shadow-git snapshot. The receipt lists shas.

```bash
harness rewind a1b2c3
```

That:

1. `git --git-dir=.harness/shadow.git reset --hard` + `clean` on the work tree
2. Truncates `messages.jsonl` to that checkpoint's turn (call/output pairs stay intact)
3. Leaves `.harness/state.json` alone

Your own git repo is never touched by rewind.

If a fact in durable state is now wrong, tell the model to `update_state` with `retract`.
