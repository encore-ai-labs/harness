/**
 * xAI Responses API client. Zero dependencies: fetch + a small SSE parser.
 *
 * Responsibilities (and nothing else):
 *   - build the request body from history + tools + options
 *   - stream it, surfacing text/reasoning deltas to the UI as they arrive
 *   - assemble the final output items and usage from `response.completed`
 *   - retry transient failures with jittered backoff
 *
 * It does NOT decide what to do with tool calls; that is the agent loop's job.
 *
 * Notes from the xAI docs (2026-09):
 *   - function calls arrive whole in a single stream event, not as argument deltas
 *   - `include: ["reasoning.encrypted_content"]` returns opaque reasoning items we
 *     pass back next turn; this keeps the prefix cache warm and the model's chain
 *     of thought intact across tool calls
 *   - `prompt_cache_key` pins the session to a cache-warm server
 *   - `store: false` keeps conversations off xAI's servers; we own the history
 *   - usage.cost_in_usd_ticks (1e-10 USD) is the exact bill for the request
 */
import type { Config } from "../config.ts";
import { estimateCost } from "../config.ts";
import { backoffMs, classifyApiError } from "../recovery/classify.ts";
import { type CompletionResult, type Item, type ToolSpec, type Usage, toWire } from "./types.ts";

export interface CompleteOptions {
  model: string;
  instructions: string;
  input: Item[];
  tools?: ToolSpec[];
  toolChoice?: "auto" | "none" | "required";
  parallelToolCalls?: boolean;
  reasoningEffort?: Config["reasoningEffort"];
  maxOutputTokens?: number;
  /** Structured output: JSON schema the model must satisfy. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /** Sticky cache routing key; use the session id. */
  cacheKey?: string;
  stream?: boolean;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  /** Fired when an output item is fully assembled (function calls arrive whole). */
  onItem?: (item: Item) => void;
  onRetry?: (attempt: number, reason: string, waitMs: number) => void;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body?: string,
  ) {
    super(message);
  }
}

export class XaiClient {
  constructor(private cfg: Config) {}

  private headers(): Record<string, string> {
    if (!this.cfg.apiKey)
      throw new ApiError(
        "XAI_API_KEY is not set. Export it in your shell or put apiKey in .harness/config.json.",
        401,
      );
    return { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` };
  }

  buildBody(o: CompleteOptions): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: o.model,
      instructions: o.instructions,
      input: o.input.map(toWire),
      store: false,
      include: ["reasoning.encrypted_content"],
      stream: o.stream ?? true,
    };
    if (o.tools?.length) {
      body.tools = o.tools;
      body.tool_choice = o.toolChoice ?? "auto";
      body.parallel_tool_calls = o.parallelToolCalls ?? true;
    }
    if (o.reasoningEffort) body.reasoning = { effort: o.reasoningEffort };
    if (o.maxOutputTokens) body.max_output_tokens = o.maxOutputTokens;
    if (o.cacheKey) body.prompt_cache_key = o.cacheKey;
    if (o.jsonSchema) {
      body.text = {
        format: {
          type: "json_schema",
          name: o.jsonSchema.name,
          schema: o.jsonSchema.schema,
          strict: true,
        },
      };
    }
    return body;
  }

  /** One model turn, with retries on transient failures. */
  async complete(o: CompleteOptions): Promise<CompletionResult> {
    const max = this.cfg.budgets.maxApiRetries;
    let attempt = 0;
    for (;;) {
      try {
        return await this.once(o);
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError((e as Error).message, null);
        const cls = classifyApiError(err.status, err.message);
        if (cls !== "api_transient" || attempt >= max || o.signal?.aborted) throw err;
        const wait = backoffMs(attempt);
        o.onRetry?.(attempt + 1, `${err.status ?? "network"}: ${err.message.slice(0, 120)}`, wait);
        await new Promise((r) => setTimeout(r, wait));
        attempt++;
      }
    }
  }

  private async once(o: CompleteOptions): Promise<CompletionResult> {
    const t0 = Date.now();
    const body = this.buildBody(o);
    const res = await fetch(`${this.cfg.baseUrl}/responses`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: o.signal,
      // Bun/Node keep the socket alive across turns so later requests reuse the TLS session.
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(`xAI ${res.status}: ${summarizeError(text)}`, res.status, text);
    }
    const response = body.stream ? await this.readStream(res, o) : ((await res.json()) as any);
    if (!response || response.error) {
      throw new ApiError(
        `xAI response error: ${JSON.stringify(response?.error ?? response).slice(0, 300)}`,
        500,
      );
    }
    return this.toResult(response, o.model, Date.now() - t0);
  }

  private toResult(r: any, model: string, ms: number): CompletionResult {
    const u = r.usage ?? {};
    const usage: Usage = {
      input_tokens: u.input_tokens ?? u.prompt_tokens ?? 0,
      output_tokens: u.output_tokens ?? u.completion_tokens ?? 0,
      total_tokens: u.total_tokens ?? 0,
      cached_tokens:
        u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
      reasoning_tokens:
        u.output_tokens_details?.reasoning_tokens ??
        u.completion_tokens_details?.reasoning_tokens ??
        0,
    };
    // Observed live (2026-09): `cost_in_usd_ticks`, 1 tick = 1e-10 USD; it reconciles exactly with
    // the published per-token rates including the cached-input discount. Docs mention
    // `cost_in_nano_usd`; accept both, fall back to the pricing table.
    if (typeof u.cost_in_usd_ticks === "number") usage.cost_usd = u.cost_in_usd_ticks / 1e10;
    else if (typeof u.cost_in_nano_usd === "number") usage.cost_usd = u.cost_in_nano_usd / 1e9;
    else usage.cost_usd = estimateCost(this.cfg, model, usage);

    const output: Item[] = Array.isArray(r.output) ? r.output : [];
    const hasCalls = output.some((i) => i.type === "function_call");
    const status = r.status ?? "completed";
    const finishReason =
      status === "incomplete"
        ? (r.incomplete_details?.reason ?? "length")
        : status !== "completed"
          ? status
          : hasCalls
            ? "tool_calls"
            : "stop";
    return { output, usage, status, finishReason, ms, responseId: r.id, ttftMs: r._ttftMs };
  }

  /** Native Responses compaction. The cursor summary is the durable local view of this. */
  async compact(
    input: Item[],
    opts: { model?: string; signal?: AbortSignal } = {},
  ): Promise<{ output: Item[]; usage: Usage }> {
    const res = await fetch(`${this.cfg.baseUrl}/responses/compact`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: opts.model ?? this.cfg.helperModel,
        input: input.map(toWire),
        store: false,
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(`xAI compact ${res.status}: ${summarizeError(text)}`, res.status, text);
    }
    const r = (await res.json()) as any;
    const usage: Usage = {
      input_tokens: r.usage?.input_tokens ?? 0,
      output_tokens: r.usage?.output_tokens ?? 0,
      total_tokens: r.usage?.total_tokens ?? 0,
      cached_tokens: r.usage?.input_tokens_details?.cached_tokens ?? 0,
      reasoning_tokens: r.usage?.output_tokens_details?.reasoning_tokens ?? 0,
    };
    if (typeof r.usage?.cost_in_usd_ticks === "number")
      usage.cost_usd = r.usage.cost_in_usd_ticks / 1e10;
    return { output: Array.isArray(r.output) ? r.output : [], usage };
  }

  /**
   * Parse the SSE stream. We forward text/reasoning deltas for display and
   * assemble the final state from `response.completed`. If the terminal event
   * never comes (connection drop), we fall back to whatever items completed.
   */
  private async readStream(res: Response, o: CompleteOptions): Promise<any> {
    if (!res.body) throw new ApiError("empty response body", null);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let final: any = null;
    const items: Item[] = [];
    let ttftMs: number | undefined;
    const t0 = Date.now();

    const handle = (evt: any) => {
      const type = evt?.type as string | undefined;
      if (!type) return;
      switch (type) {
        case "response.output_text.delta":
          if (ttftMs === undefined) ttftMs = Date.now() - t0;
          if (evt.delta) o.onText?.(evt.delta);
          break;
        case "response.reasoning_text.delta":
        case "response.reasoning_summary_text.delta":
          if (ttftMs === undefined) ttftMs = Date.now() - t0;
          if (evt.delta) o.onReasoning?.(evt.delta);
          break;
        case "response.output_item.done":
          if (evt.item) {
            items.push(evt.item);
            o.onItem?.(evt.item);
          }
          break;
        case "response.completed":
          final = evt.response ?? final;
          break;
        case "response.incomplete":
          final = evt.response ?? final;
          if (final) final.status = final.status ?? "incomplete";
          break;
        case "response.failed":
          throw new ApiError(
            `stream failed: ${JSON.stringify(evt.response?.error ?? evt).slice(0, 300)}`,
            500,
          );
        case "error":
          throw new ApiError(
            `stream error: ${evt.message ?? JSON.stringify(evt).slice(0, 200)}`,
            evt.status ?? 500,
          );
        default:
          break;
      }
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = chunk
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        try {
          handle(JSON.parse(data));
        } catch (e) {
          if (e instanceof ApiError) throw e;
          /* ignore unparsable keepalives */
        }
      }
    }
    if (final) {
      if (!Array.isArray(final.output) || final.output.length === 0) final.output = items;
      final._ttftMs = ttftMs;
      return final;
    }
    throw new ApiError("stream ended without a response.completed event", null);
  }
}

function summarizeError(text: string): string {
  try {
    const j = JSON.parse(text);
    return j.error?.message ?? j.error ?? j.message ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}
