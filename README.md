# harness

A local coding agent around [xAI Grok](https://docs.x.ai). One loop, a tool gateway, durable state, and a receipt you can audit. Built to be a daily driver for Grok 4.6, and small enough to read.

**Worker:** `grok-4.6`. **Helper:** `grok-4.5` (contracts, compaction). **Verifier:** `grok-4.6`. Transport is the Responses API with `store: false` — history lives on your disk.

## Install

```bash
cd harness
bun install
export XAI_API_KEY=...   # already in ~/.zshrc is fine
bun run src/index.ts chat
```

Optional: `bun link` from this directory so `harness` is on your PATH.

## First five minutes

```bash
harness chat
harness skill add EvanBacon/serve-sim
harness run "add a failing test then make it pass"
harness sessions
harness show --receipt
```

`chat` is the fast path (medium effort, no contract, no verifier). `run` is the slow path (verifies, writes a receipt). Neither needs a server.

## What it enforces

The prompt can say these. The loop actually does:

- **How before mutate** — read or grep a file before you edit it.
- **Plan before write** — `harness run` requires `update_plan` before the first write.
- **Policy** — edit mode auto-runs workspace edits; network and irreversible commands ask (or deny if you are not at a TTY).
- **Receipt** — `receipt.md` only claims events that exist in `trace.jsonl`.
- **Skills** — catalog in the map, `SKILL.md` via the `skill` tool. `harness skill add owner/repo`.

## Layout

```
src/agent/loop.ts     boot / run / rewindTo — the only orchestrator
src/tools/            gateway + file/bash/state tools
src/policy/           risk classes, sandbox, shell parser
src/provider/         xAI Responses client + fake client for tests
src/state/            session, trace, checkpoints, durable facts
docs/                 tutorials, how-tos, reference, explanation
```

Two processes in one repo will race. Don't.

## Check

```bash
bun test
bun run typecheck
bun run lint
bun run format:check
```
