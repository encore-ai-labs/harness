# Safety

Nothing here depends on the model remembering a rule.

**Risk** (policy): read / reversible / external / irreversible. Drives allow / ask / deny.

**Access** (concurrency): read / write. `update_state` is risk-read (always allowed) and access-write (serializes). Mixing those was a bug: the model could "read" in parallel while mutating JSON.

**Path**: every file tool resolves against cwd. `.git` and `.harness` are refused in the precondition, not the prompt.

**Shell**: a small parser splits `&&` / `|` / quotes. Opaque constructs (`$()`, nested `bash -c`, redirections) bump the risk to **external**, so they cannot auto-run in edit mode.

**Sandbox**: auto + bash + macOS `sandbox-exec`. Allow-list matches keep the sandbox on. If the sandbox was requested and is missing, deny.

**Approvals**: irreversible requires typing `yes`. Non-interactive `ask` becomes `deny` and shows up as APPROVAL NEEDED.

**Gates**: how-before-mutate and plan-before-write are loop rules. The prompt mentions them so Grok cooperates; the gateway/loop still enforces them when it doesn't.
