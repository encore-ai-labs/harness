# Use Agent Skills

The harness discovers `SKILL.md` folders the same way Cursor and Claude Code do, then loads bodies on demand with the `skill` tool. The catalog is a few lines in the project map so the prompt cache stays small.

## Where skills are found

User (later roots win on a name clash):

- `~/.claude/skills`
- `~/.agents/skills`
- `~/.cursor/skills`
- `~/.harness/skills`

Project:

- `<cwd>/skills`
- `<cwd>/.agents/skills`
- `<cwd>/.cursor/skills`
- `<cwd>/.harness/skills`

If you already have Expo's [serve-sim](https://github.com/EvanBacon/serve-sim) at `~/.agents/skills/serve-sim`, chat will list it. Ask the agent to tap a simulator and it should call `skill` then follow that file — not invent a CLI.

## Install

```bash
harness skill add EvanBacon/serve-sim
harness skill add https://github.com/EvanBacon/serve-sim
harness skill add ./path/to/skill
harness skill add EvanBacon/serve-sim --project   # this repo only
harness skill add EvanBacon/serve-sim --force     # overwrite
harness skill remove serve-sim                    # only ~/.harness/skills
```

`add` copies into `~/.harness/skills` (or `.harness/skills` with `--project`). It does not delete skills that live under `~/.agents`.

## What the model sees

A catalog line (`serve-sim [user] Control an Apple Simulator…`). To read `SKILL.md` or `references/gestures.md` it must call the `skill` tool. `read` cannot leave the workspace, which is why home-directory skills need that tool.

Simulator control still goes through `bash` (`npx @expo/serve-sim tap 0.5 0.5`). In `auto` mode that may hit the seatbelt; approve an unsandboxed retry, or stay in `edit`.
