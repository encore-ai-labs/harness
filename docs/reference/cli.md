# CLI

```
harness chat [prompt]
harness run "<task>"
harness resume [session-id]
harness sessions
harness rewind <sha>
harness show [id] --receipt|--trace
harness skill
harness skill add <github-or-path> [--project] [--force]
harness skill remove <name> [--project]
```

Flags (all commands that boot a session):

| Flag | Meaning |
| --- | --- |
| `--model ID` | worker (default `grok-4.6`) |
| `--mode ask\|edit\|auto\|plan` | policy |
| `--contract auto\|always\|never` | helper contract. `auto` = only non-interactive |
| `--sandbox` / `--no-sandbox` | seatbelt for auto bash |
| `--network` / `--no-network` | sandbox network |
| `--max-cost USD` | session cap |
| `--max-turns N` | model round-trips per request |
| `--effort low\|medium\|high\|xhigh` | chat defaults to medium |

`sessions`, `show`, `rewind`, and `skill` do not need `XAI_API_KEY`.

Paste a screenshot in chat (macOS clipboard on an empty paste, an image file path, or iTerm2 OSC 1337). Grok sees it as `input_image`.

Exit: `run` exits 0 only when session status is `completed`.
