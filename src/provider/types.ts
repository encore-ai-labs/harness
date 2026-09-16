/**
 * Wire types for the xAI Responses API (POST /v1/responses).
 *
 * Why Responses and not chat/completions: xAI marks chat completions as legacy
 * and ships new capabilities (server-side tools, encrypted reasoning, context
 * compaction, prompt_cache_key) on Responses first. The in-memory history is
 * kept in the exact wire shape, so a session on disk is exactly what the model
 * saw, and replaying it is trivial.
 *
 * A conversation is a flat list of *items*:
 *   message               { role, content }                       user/system/assistant text
 *   function_call         { call_id, name, arguments }             model asked for a tool
 *   function_call_output  { call_id, output }                      harness answered
 *   reasoning             { encrypted_content, summary }           opaque; passed back for cache hits
 *   (server tool items)   web_search_call, code_interpreter_call…  passthrough
 */

export type Role = "system" | "developer" | "user" | "assistant";

export interface InputText {
  type: "input_text";
  text: string;
}
export interface OutputText {
  type: "output_text";
  text: string;
  annotations?: unknown[];
}
export interface InputImage {
  type: "input_image";
  image_url: string;
  detail?: "low" | "high" | "auto";
}
export type ContentPart =
  | InputText
  | OutputText
  | InputImage
  | { type: string; [k: string]: unknown };

export interface UserImage {
  mime: "image/png" | "image/jpeg";
  bytes: Uint8Array;
  name?: string;
}

/** Harness-only metadata, stripped before sending to the wire. */
export interface ItemMeta {
  turn?: number;
  /** tool output was replaced by a stub to save context */
  pruned?: boolean;
  kind?: "reminder" | "summary" | "verify" | "contract" | "user";
  /** original size before truncation/pruning */
  chars?: number;
  ts?: string;
}

export interface MessageItem {
  type: "message";
  role: Role;
  content: string | ContentPart[];
  id?: string;
  status?: string;
  meta?: ItemMeta;
}
export interface FunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  id?: string;
  status?: string;
  meta?: ItemMeta;
}
export interface FunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
  meta?: ItemMeta;
}
export interface ReasoningItem {
  type: "reasoning";
  id?: string;
  encrypted_content?: string;
  summary?: unknown[];
  meta?: ItemMeta;
}
export interface OtherItem {
  type: string;
  id?: string;
  meta?: ItemMeta;
  [k: string]: unknown;
}

export type Item =
  | MessageItem
  | FunctionCallItem
  | FunctionCallOutputItem
  | ReasoningItem
  | OtherItem;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  /** Provided by xAI: exact cost of the request. */
  cost_usd?: number;
}

export const ZERO_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  cached_tokens: 0,
  reasoning_tokens: 0,
};

/** A function tool as the Responses API wants it (flat, no `function` wrapper). */
export interface FunctionToolSpec {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}
/** Server-side tools executed by xAI (web_search, x_search, code_interpreter, …). */
export interface ServerToolSpec {
  type: string;
  [k: string]: unknown;
}
export type ToolSpec = FunctionToolSpec | ServerToolSpec;

export interface CompletionResult {
  /** New items produced by the model this turn, in order (reasoning, message, function_call, …). */
  output: Item[];
  usage: Usage;
  status: string;
  /** "stop" | "tool_calls" | "length" | "error" */
  finishReason: string;
  ms: number;
  responseId?: string;
  ttftMs?: number;
}

/** Anything the loop can talk to. XaiClient and FakeClient both implement this. */
export interface Provider {
  complete(o: {
    model: string;
    instructions: string;
    input: Item[];
    tools?: ToolSpec[];
    toolChoice?: "auto" | "none" | "required";
    parallelToolCalls?: boolean;
    reasoningEffort?: "low" | "medium" | "high" | "xhigh";
    maxOutputTokens?: number;
    jsonSchema?: { name: string; schema: Record<string, unknown> };
    cacheKey?: string;
    stream?: boolean;
    signal?: AbortSignal;
    onText?: (delta: string) => void;
    onReasoning?: (delta: string) => void;
    onItem?: (item: Item) => void;
    onRetry?: (attempt: number, reason: string, waitMs: number) => void;
  }): Promise<CompletionResult>;
  compact?(
    input: Item[],
    opts?: { model?: string; signal?: AbortSignal },
  ): Promise<{ output: Item[]; usage: Usage }>;
}

export function isMessage(i: Item): i is MessageItem {
  return i.type === "message";
}
export function isFunctionCall(i: Item): i is FunctionCallItem {
  return i.type === "function_call";
}
export function isFunctionOutput(i: Item): i is FunctionCallOutputItem {
  return i.type === "function_call_output";
}
export function isReasoning(i: Item): i is ReasoningItem {
  return i.type === "reasoning";
}

/** Plain text of a message item (joins text parts). */
export function textOf(i: Item): string {
  if (!isMessage(i)) return "";
  if (typeof i.content === "string") return i.content;
  return i.content
    .map((p) => {
      if ("text" in p && typeof p.text === "string") return p.text;
      if (p.type === "input_image") return "[image]";
      return "";
    })
    .join("");
}

export function userMessage(text: string, meta?: ItemMeta, images?: UserImage[]): MessageItem {
  const base = { ts: new Date().toISOString(), ...meta };
  if (!images?.length) {
    return { type: "message", role: "user", content: text, meta: base };
  }
  const parts: ContentPart[] = images.map((img) => ({
    type: "input_image",
    image_url: `data:${img.mime};base64,${Buffer.from(img.bytes).toString("base64")}`,
    detail: "high" as const,
  }));
  parts.push({ type: "input_text", text: text.trim() || "(see attached image)" });
  return { type: "message", role: "user", content: parts, meta: base };
}

/** Harness → model. Not the human. Used for the ephemeral workspace/state reminder. */
export function developerMessage(text: string, meta?: ItemMeta): MessageItem {
  return {
    type: "message",
    role: "developer",
    content: text,
    meta: { ts: new Date().toISOString(), ...meta },
  };
}

/** Strip harness metadata (and anything the API would reject) before sending. */
export function toWire(i: Item): Record<string, unknown> {
  const { meta: _m, ...rest } = i as any;
  if (rest.type === "message" && rest.role === "assistant" && Array.isArray(rest.content)) {
    // Assistant output_text parts are accepted as-is; drop annotations to keep the payload small.
    rest.content = rest.content.map((p: any) =>
      p.type === "output_text" ? { type: "output_text", text: p.text } : p,
    );
  }
  return rest;
}

/** Rough token estimate: 1 token ≈ 4 chars of English/code. Used for budgets and compaction triggers only. */
export function approxTokens(items: Item[], extraChars = 0): number {
  let chars = extraChars;
  for (const i of items) {
    if (isMessage(i)) {
      chars += textOf(i).length;
      if (Array.isArray(i.content))
        chars += i.content.filter((p) => p.type === "input_image").length * 6400;
    } else if (isFunctionCall(i)) chars += i.name.length + i.arguments.length;
    else if (isFunctionOutput(i)) chars += i.output.length;
    else if (isReasoning(i)) chars += 0; // encrypted; not re-billed as input in the same way, ignore
    else chars += JSON.stringify(i).length;
    chars += 12; // per-item overhead
  }
  return Math.ceil(chars / 4);
}
