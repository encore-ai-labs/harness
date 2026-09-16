# Decision: Responses API, local history

xAI marks chat/completions as legacy. Encrypted reasoning, `prompt_cache_key`, native compact, and `cost_in_usd_ticks` ship on Responses first.

We send `store: false`. The session directory is the conversation. Resume is "replay these items," not "please remember id X."

Encrypted reasoning items are passed back verbatim so the prefix cache stays warm. We never print them as if they were thoughts we understood.
