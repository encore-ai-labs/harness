/**
 * Tool contract. Every tool declares, up front:
 *
 *   parameters     JSON schema the model must satisfy (validated before execution)
 *   risk           the risk class of a given call (can depend on the arguments)
 *   precondition   cheap checks that must hold before anything runs (path in
 *                  workspace, file exists, old_string is unique, …)
 *   execute        does the work and returns structured evidence, not "ok"
 *
 * The gateway (tools/index.ts) is the only thing that calls `execute`, and it
 * always goes: validate → precondition → policy → execute → evidence. The
 * model never touches a tool directly.
 */
import type { Config } from "../config.ts";
import type { Trace } from "../state/trace.ts";
import type { StateStore } from "../state/store.ts";
import type { FailureClass } from "../recovery/classify.ts";

/**
 * Risk classes drive policy (policy/policy.ts):
 *   read          observe only: automatic
 *   reversible    changes the workspace; a checkpoint can undo it
 *   external      effects leave the machine or the workspace (network, git push, publish)
 *   irreversible  destroys data or cannot be undone by a checkpoint
 */
export type RiskClass = "read" | "reversible" | "external" | "irreversible";
export type ToolAccess = "read" | "write";

export interface ToolContext {
  cwd: string;
  config: Config;
  trace: Trace;
  state: StateStore;
  sessionId: string;
  turn: number;
  /** Set when the call is running automatically and bash should be sandboxed. */
  sandboxed: boolean;
  signal?: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  /** Text the model sees. Truncated by the gateway to config.context.maxToolOutputChars. */
  output: string;
  /** Structured facts about what happened, for the trace and the receipt. */
  evidence?: Record<string, unknown>;
  /** Files this call changed (relative paths), for checkpoints and the receipt. */
  changed?: string[];
  failureClass?: FailureClass;
  /** Short summary for the UI line. */
  summary?: string;
}

export interface ToolDefinition<A = any> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  risk: (args: A, ctx: ToolContext) => RiskClass;
  access?: (args: A) => ToolAccess;
  /** Return an error string to refuse the call before policy/execution, or null to proceed. */
  precondition?: (args: A, ctx: ToolContext) => Promise<string | null> | string | null;
  execute: (args: A, ctx: ToolContext) => Promise<ToolResult>;
  /** One-line summary of the call for the UI and the approval prompt. */
  summarize: (args: A) => string;
}

export function fail(
  output: string,
  failureClass?: FailureClass,
  extra: Partial<ToolResult> = {},
): ToolResult {
  return { ok: false, output, failureClass, ...extra };
}
export function ok(output: string, extra: Partial<ToolResult> = {}): ToolResult {
  return { ok: true, output, ...extra };
}
