/**
 * Tool-free helper jobs: contract, compact compile, verifier verdict.
 * Billed to the session, never appended to the worker transcript.
 */
import { estimateCost, type Config } from "../config.ts";
import { parseContract, CONTRACT_SCHEMA, type Contract } from "./contract.ts";
import { userMessage, textOf, type Item, type Provider } from "../provider/types.ts";
import type { Session } from "../state/session.ts";
import type { Trace } from "../state/trace.ts";
import type { StateStore } from "../state/store.ts";

export interface HelperHost {
  cwd: string;
  cfg: Config;
  client: Provider;
  session: Session;
  trace: Trace;
  map: { commands: Record<string, string> };
  signal?: AbortSignal;
  state: StateStore;
}

export async function askJson<T>(
  rt: HelperHost,
  opts: {
    model?: string;
    instructions: string;
    input: string;
    schema: { name: string; schema: Record<string, unknown> };
    parse: (raw: unknown) => T | { error: string };
  },
): Promise<T> {
  const model = opts.model ?? rt.cfg.helperModel;
  const result = await rt.client.complete({
    model,
    instructions: opts.instructions,
    input: [userMessage(opts.input)],
    jsonSchema: opts.schema,
    reasoningEffort: "low",
    stream: false,
    cacheKey: rt.session.id + ":helper:" + opts.schema.name,
    signal: rt.signal,
  });
  const cost = estimateCost(rt.cfg, model, result.usage);
  rt.session.addUsage(result.usage, cost);
  rt.trace.log({
    ev: "model.response",
    turn: rt.session.meta.turns,
    ms: result.ms,
    usage: result.usage,
    costUsd: cost,
    toolCalls: 0,
    finish: result.finishReason,
    ttftMs: result.ttftMs,
    cachedFraction: result.usage.input_tokens
      ? result.usage.cached_tokens / result.usage.input_tokens
      : 0,
  });
  const text =
    result.output.map(textOf).join("") ||
    (result.output[0] ? JSON.stringify(result.output[0]) : "");
  let raw: unknown = text;
  try {
    raw = JSON.parse(text);
  } catch {
    /* keep string */
  }
  const parsed = opts.parse(raw);
  if (parsed && typeof parsed === "object" && "error" in parsed)
    throw new Error(String((parsed as { error: string }).error));
  return parsed as T;
}

export async function draftContract(rt: HelperHost, task: string): Promise<Contract> {
  return askJson(rt, {
    schema: CONTRACT_SCHEMA,
    parse: parseContract,
    instructions:
      "Draft a short execution contract for a coding agent. checks are shell commands that must pass when the work is done. " +
      "Prefer the project's known test/typecheck commands. Keep arrays short. JSON only.",
    input: `Workspace: ${rt.cwd}\nKnown commands: ${JSON.stringify(rt.map.commands)}\nTask:\n${task}`,
  });
}

export async function compileState(rt: HelperHost, recent: Item[]): Promise<void> {
  const text = recent
    .map((i) => {
      if (i.type === "message") return `${i.role}: ${textOf(i).slice(0, 800)}`;
      if (i.type === "function_call" && "arguments" in i)
        return `call ${i.name} ${String(i.arguments).slice(0, 200)}`;
      if (i.type === "function_call_output" && "output" in i)
        return `out ${String(i.output).slice(0, 200)}`;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .slice(0, 24_000);
  const schema = {
    name: "state_compile",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["facts", "decisions", "lessons"],
      properties: {
        facts: { type: "array", items: { type: "string" } },
        decisions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["text", "reason"],
            properties: { text: { type: "string" }, reason: { type: "string" } },
          },
        },
        lessons: { type: "array", items: { type: "string" } },
      },
    },
  };
  try {
    const compiled = await askJson<{
      facts: string[];
      decisions: Array<{ text: string; reason: string }>;
      lessons: string[];
    }>(rt, {
      schema,
      parse: (raw) => {
        if (!raw || typeof raw !== "object") return { error: "expected object" };
        return raw as {
          facts: string[];
          decisions: Array<{ text: string; reason: string }>;
          lessons: string[];
        };
      },
      instructions:
        "Extract durable facts, decisions, and lessons from this transcript fragment. Skip transient progress. JSON only.",
      input: text || "(empty)",
    });
    rt.state.update(compiled);
  } catch {
    /* compile is best-effort; native compact is the source of truth */
  }
}
