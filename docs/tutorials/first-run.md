# First run

Do a toy task and look at what the harness wrote to disk. You need `XAI_API_KEY` and Bun.

## 1. Chat

From a project directory:

```bash
harness chat "what does src/index.ts do?"
```

You should see your prompt in a dark banner, a cycling spinner while it thinks (`just choding…`, `choding around…`, … — `/think` peeks at the actual reasoning), grouped tool work (`Read, globbed, grepped …` and green `Edited file +N` previews), then the answer as markdown. Type another `›` message while it is working to interrupt and steer. Paste a screenshot; on macOS an empty paste reads the clipboard. Ctrl-C interrupts without sending a message.

Slash commands: `/think`, `/cost`, `/rewind <sha>`, `/quit`. Skills: `harness skill add EvanBacon/serve-sim` (see [use skills](../how-to/use-skills.md)).

## 2. Inspect `.harness/`

```
.harness/
  sessions/<id>/
    meta.json        id, model, cost, contract, cursor
    messages.jsonl   every Responses item, append-only
    trace.jsonl      what actually happened
    receipt.md       claims folded from the trace
  shadow.git/        checkpoints (not your repo)
  state.json         facts / decisions / lessons
  plan.json          the model's step list
```

```bash
harness show --receipt
harness show --trace
```

`sessions` and `show` do not call xAI. They work without an API key.

## 3. Run (verified)

```bash
harness run "add a function add(a,b) and a test"
```

`run` drafts a contract (unless `--contract never`), requires a plan before the first write, runs checks, asks the verifier, and writes `receipt.md`. If the verifier rejects, the worker gets one repair round.

## 4. Resume

```bash
harness resume
harness rewind <sha-from-receipt>
```

Rewind restores the work tree from the shadow git and truncates the transcript to that turn. Durable `state.json` is not silently rewritten; the model can retract stale facts next turn.
