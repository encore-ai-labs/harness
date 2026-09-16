# Decision: receipts fold the trace

A helper-written "summary of what I did" is prose. It can claim a test that never ran.

`receipt.md` is compiled from `trace.jsonl` in process. If a file, check, or approval is not an event, it does not appear. That makes the receipt a teaching tool: when something looks wrong, open the trace, not the assistant text.
