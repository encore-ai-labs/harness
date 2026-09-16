# Configuration

Merge order: defaults → `~/.config/harness/config.json` → `<cwd>/.harness/config.json` → env → CLI flags.

Env: `XAI_API_KEY`, `XAI_BASE_URL`, `HARNESS_MODEL`, `HARNESS_MODE`.

```json
{
  "model": "grok-4.6",
  "helperModel": "grok-4.5",
  "verifierModel": "grok-4.6",
  "mode": "edit",
  "contract": "auto",
  "sandbox": true,
  "network": false,
  "reasoningEffort": "medium",
  "budgets": {
    "maxTurns": 80,
    "maxCostUsd": 5,
    "maxMinutes": 30,
    "maxVerifyRounds": 2
  },
  "context": {
    "window": 500000,
    "compactAtTokens": 160000,
    "pruneAfterTurns": 12,
    "pruneMinChars": 40000
  },
  "permissions": {
    "allow": ["bun test *"],
    "deny": ["git push --force*"]
  }
}
```

Pricing fallback (USD / 1M tokens, <200k prompt). The API's `cost_in_usd_ticks` wins when present. Prompts ≥200k bill 2×; we compact at 160k so we stay off that cliff.
