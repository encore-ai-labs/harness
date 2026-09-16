# Decision: compact before the Grok 4.6 cost cliff

Context window is 500k. Billing doubles every token in a request once the prompt is ≥200k.

We compact at 160k. Native `POST /v1/responses/compact` is the provider view. A helper compile into `state.json` is local memory. A helper-only summary is not the source of truth — if compact fails, we keep the full projection rather than inventing one.
