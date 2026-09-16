# Run safely

Default mode is **edit**: reads and workspace edits run; network, publish, and irreversible commands still ask.

```bash
harness chat --mode ask      # every write asks
harness chat --mode edit     # default
harness run --mode auto --no-network --sandbox
harness chat --mode plan     # read-only; write tools are hidden
```

## What auto actually means

Auto does **not** mean "the model may curl and force-push." External and irreversible still ask. Auto means reversible bash runs inside the macOS seatbelt: no network, writes limited to the workspace and tmp, `.git` read-only. If `sandbox-exec` is missing, auto **denies** bash instead of running it naked.

Allow-list patterns in `.harness/config.json` skip the approval prompt. They do **not** disable the sandbox.

## Irreversible

`rm -rf`, `git reset --hard`, `git push --force` require typing `yes`. A stray `y` is not enough.

## Non-interactive

`harness run` cannot ask. Anything that would have asked is denied and listed in the receipt under **APPROVAL NEEDED**.

## Two processes

There is no workspace lease. Two `harness` processes in one repo will race on `state.json`, the shadow git, and files. Don't.
