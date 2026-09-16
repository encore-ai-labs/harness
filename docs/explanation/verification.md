# Verification

`harness chat` does not verify. Explaining a file should not cost a second model.

`harness run` cannot finish on assistant prose if files changed:

1. **Checks** — contract `checks[]` plus the project's known `test` / `typecheck` / `lint` commands. Each one is `gateway.call` with `call_id: verify-N`. Policy, sandbox, and timeout still apply. The worker did not author those calls.
2. **Verifier** — grok-4.6 on a fresh small context: contract, capped diff, check tails, last claim. JSON `{ verdict, findings }`. `pass` is illegal if a check failed. `inconclusive` is not a pass.
3. **Repair** — findings come back as a user message. Max two rounds, then escalate.

The receipt lists every check and the verdict. If it is not in the trace, it is not in the receipt.
