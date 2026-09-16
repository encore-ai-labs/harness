/**
 * Scripted provider for offline tests. Queue CompletionResults; complete()
 * shifts one per call. compact() returns a canned summary unless overridden.
 */
import type { CompletionResult, Item, Provider, Usage } from "./types.ts";
import { ZERO_USAGE, userMessage, textOf, isMessage } from "./types.ts";
import type { CompleteOptions } from "./xai.ts";

export class FakeClient implements Provider {
  calls: CompleteOptions[] = [];
  compactCalls = 0;
  constructor(
    private queue: CompletionResult[],
    private compactOutput: Item[] = [userMessage("compacted prior turns", { kind: "summary" })],
    readonly opts: { hang?: boolean } = {},
  ) {}

  async complete(o: CompleteOptions): Promise<CompletionResult> {
    this.calls.push(o);
    if (o.signal?.aborted) throw abortErr();
    if (this.opts.hang) {
      await new Promise<never>((_, rej) => {
        o.signal?.addEventListener("abort", () => rej(abortErr()), { once: true });
      });
    }
    const next = this.queue.shift();
    if (!next) throw new Error("FakeClient: no more scripted responses");
    for (const item of next.output) {
      o.onItem?.(item);
      if (isMessage(item) && item.role === "assistant") {
        const text = textOf(item);
        if (text) o.onText?.(text);
      }
    }
    return next;
  }

  async compact(input: Item[]): Promise<{ output: Item[]; usage: Usage }> {
    this.compactCalls++;
    void input;
    return { output: this.compactOutput, usage: { ...ZERO_USAGE } };
  }
}

export function fakeTurn(output: Item[], extra: Partial<CompletionResult> = {}): CompletionResult {
  const hasCalls = output.some((i) => i.type === "function_call");
  return {
    output,
    usage: extra.usage ?? {
      ...ZERO_USAGE,
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    },
    status: "completed",
    finishReason: hasCalls ? "tool_calls" : "stop",
    ms: extra.ms ?? 10,
    ttftMs: extra.ttftMs ?? 2,
    ...extra,
  };
}

export function fc(
  name: string,
  args: unknown,
  call_id = `c-${name}-${Math.random().toString(36).slice(2, 6)}`,
): Item {
  return { type: "function_call", call_id, name, arguments: JSON.stringify(args) };
}

export function assistant(text: string): Item {
  return { type: "message", role: "assistant", content: text };
}

function abortErr(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}
