/**
 * Tool gateway: the only path from a model's intent to an effect on the world.
 *
 *   model decides intent      → function_call item
 *   gateway validates action  → schema, precondition, risk, policy, approval
 *   tool changes environment  → execute()
 *   sensor observes result    → evidence + failure class → function_call_output
 *
 * Everything in here is enforced, not suggested. The prompt tells the model
 * how to behave well; the gateway makes sure misbehaviour is bounded.
 */
import type { Config, Mode } from "../config.ts";
import type { FunctionCallItem, FunctionToolSpec } from "../provider/types.ts";
import { HINTS, type FailureClass } from "../recovery/classify.ts";
import { type Decision, Policy, classifyBash } from "../policy/policy.ts";
import { parseShell } from "../policy/shell.ts";
import type { Trace } from "../state/trace.ts";
import {
  type RiskClass,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
  fail,
} from "./types.ts";
import { validate } from "./schema.ts";
import { readTool } from "./read.ts";
import { lsTool } from "./ls.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { writeTool } from "./write.ts";
import { editTool } from "./edit.ts";
import { applyPatchTool } from "./apply_patch.ts";
import { bashTool } from "./bash.ts";
import { skillTool } from "./skill.ts";
import { updatePlanTool, updateStateTool } from "./state.ts";

export const ALL_TOOLS: ToolDefinition[] = [
  readTool,
  lsTool,
  globTool,
  grepTool,
  skillTool,
  editTool,
  applyPatchTool,
  writeTool,
  bashTool,
  updatePlanTool,
  updateStateTool,
];

export interface ApprovalRequest {
  tool: string;
  summary: string;
  risk: RiskClass;
  reason: string;
  /** Patterns the user can choose to always allow (bash only). */
  alwaysPatterns: string[];
  args: unknown;
  /** Set when asking whether to retry a sandbox-blocked command without the sandbox. */
  escalation?: boolean;
}
export type ApprovalAnswer =
  | { kind: "once" }
  | { kind: "always" }
  | { kind: "reject"; feedback?: string };

export interface GatewayOutcome {
  result: ToolResult;
  decision: Decision;
  risk: RiskClass;
  ms: number;
  args: unknown;
}

export class ToolGateway {
  private byName = new Map<string, ToolDefinition>();

  constructor(
    tools: ToolDefinition[],
    readonly policy: Policy,
    private trace: Trace,
    private cfg: Config,
    private askApproval: (req: ApprovalRequest) => Promise<ApprovalAnswer>,
  ) {
    for (const t of tools) this.byName.set(t.name, t);
  }

  /** Tools the model can see in the current mode. Plan mode hides mutating tools rather than letting the model try and fail. */
  specs(mode: Mode): FunctionToolSpec[] {
    const hidden = mode === "plan" ? new Set(["write", "edit", "apply_patch"]) : new Set<string>();
    return [...this.byName.values()]
      .filter((t) => !hidden.has(t.name))
      .map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
  }

  /** Read-access tools may run concurrently; write-access serializes even when policy risk is "read". */
  isParallelSafe(call: FunctionCallItem): boolean {
    const t = this.byName.get(call.name);
    if (!t) return true;
    let args: any = {};
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {
      return false;
    }
    if (t.access) return t.access(args) === "read";
    if (t.name === "bash") return classifyBash(args.command ?? "").risk === "read";
    try {
      return t.risk(args, undefined as any) === "read";
    } catch {
      return false;
    }
  }

  async call(call: FunctionCallItem, ctx: ToolContext): Promise<GatewayOutcome> {
    const t0 = Date.now();
    const done = (
      result: ToolResult,
      decision: Decision,
      risk: RiskClass,
      args: unknown,
    ): GatewayOutcome => {
      const ms = Date.now() - t0;
      if (!result.ok && result.failureClass)
        result.output += `\n\n[harness: ${result.failureClass}] ${HINTS[result.failureClass]}`;
      result.output = truncate(result.output, this.cfg.context.maxToolOutputChars);
      this.trace.log({
        ev: "tool.result",
        id: call.call_id,
        name: call.name,
        ok: result.ok,
        ms,
        evidence: result.evidence,
        changed: result.changed,
        error: result.ok ? undefined : result.output.slice(0, 300),
        failureClass: result.failureClass,
      });
      return { result, decision, risk, ms, args };
    };
    const refuse = (
      msg: string,
      cls: FailureClass,
      risk: RiskClass = "read",
      args: unknown = null,
    ) => done(fail(msg, cls), { action: "deny", reason: msg }, risk, args);

    // 1. parse + lookup
    let args: any;
    try {
      args = call.arguments?.trim() ? JSON.parse(call.arguments) : {};
    } catch (e) {
      return refuse(`arguments are not valid JSON: ${(e as Error).message}`, "invalid_args");
    }
    const tool = this.byName.get(call.name);
    if (!tool)
      return refuse(
        `unknown tool "${call.name}". Available: ${[...this.byName.keys()].join(", ")}`,
        "invalid_args",
      );

    // 2. schema
    const problems = validate(tool.parameters, args);
    if (problems.length)
      return refuse(`invalid arguments for ${tool.name}: ${problems.join("; ")}`, "invalid_args");

    // 3. precondition (cheap, deterministic, before any policy prompt)
    if (tool.precondition) {
      const p = await tool.precondition(args, ctx);
      if (p)
        return refuse(
          p,
          /does not exist|not found/i.test(p) ? "not_found" : "invalid_args",
          "read",
          args,
        );
    }

    // 4. risk + policy
    let risk = tool.risk(args, ctx);
    let bashInfo: { commands: string[]; reasons: string[]; patterns: string[] } | undefined;
    if (tool.name === "bash") {
      const c = classifyBash(args.command);
      risk = c.risk;
      bashInfo = {
        commands: parseShell(args.command).commands.map((x) => x.raw),
        reasons: c.reasons,
        patterns: c.patterns,
      };
    }
    this.trace.log({
      ev: "tool.proposed",
      turn: ctx.turn,
      id: call.call_id,
      name: tool.name,
      args: redact(args),
      risk,
    });
    let decision = this.policy.decide(tool.name, risk, {
      bashCommands: bashInfo?.commands,
      reasons: bashInfo?.reasons,
    });

    // 5. approval
    if (decision.action === "ask") {
      const answer = await this.askApproval({
        tool: tool.name,
        summary: tool.summarize(args),
        risk,
        reason: decision.reason,
        alwaysPatterns: bashInfo?.patterns ?? [],
        args,
      });
      if (answer.kind === "reject") {
        decision = { action: "deny", reason: "rejected by user" };
        this.trace.log({
          ev: "tool.decision",
          id: call.call_id,
          name: tool.name,
          decision: "deny",
          reason: "user rejected",
        });
        return done(
          fail(
            `The user rejected this ${tool.name} call${answer.feedback ? ` with feedback: ${answer.feedback}` : ""}. Do not retry it unchanged; choose another approach or ask what they prefer.`,
            "permission_denied",
          ),
          decision,
          risk,
          args,
        );
      }
      if (answer.kind === "always")
        for (const p of bashInfo?.patterns ?? []) this.policy.addSessionAllow(p);
      decision = { action: "allow", reason: `approved by user (${answer.kind})`, sandbox: false };
    }
    this.trace.log({
      ev: "tool.decision",
      id: call.call_id,
      name: tool.name,
      decision: decision.action,
      reason: decision.reason,
    });
    if (decision.action === "deny") {
      this.trace.log({ ev: "policy.blocked", name: tool.name, reason: decision.reason });
      return done(
        fail(`blocked by policy: ${decision.reason}`, "permission_denied"),
        decision,
        risk,
        args,
      );
    }

    // 6. execute (sandboxed if policy said so), with a timeout for non-bash tools
    const run = (sandboxed: boolean) => {
      const ac = new AbortController();
      const onParent = () => ac.abort();
      ctx.signal?.addEventListener("abort", onParent, { once: true });
      return withTimeout(
        tool.execute(args, { ...ctx, sandboxed, signal: ac.signal }),
        tool.name === "bash" ? 0 : this.cfg.budgets.toolTimeoutMs,
        ac,
      ).finally(() => ctx.signal?.removeEventListener("abort", onParent));
    };
    let result: ToolResult;
    try {
      result = await run(!!decision.sandbox);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      result = fail(
        `${tool.name} failed: ${msg}`,
        /timed out/.test(msg) ? "tool_timeout" : "unknown",
      );
    }

    // 7. sandbox escalation: the command hit the sandbox wall → ask the human to rerun without it
    if (
      !result.ok &&
      decision.sandbox &&
      result.failureClass === "permission_denied" &&
      this.policy.interactive
    ) {
      const answer = await this.askApproval({
        tool: tool.name,
        summary: tool.summarize(args),
        risk,
        reason: "blocked by the sandbox; rerun without sandbox?",
        alwaysPatterns: bashInfo?.patterns ?? [],
        args,
        escalation: true,
      });
      if (answer.kind !== "reject") {
        if (answer.kind === "always")
          for (const p of bashInfo?.patterns ?? []) this.policy.addSessionAllow(p);
        this.trace.log({
          ev: "tool.decision",
          id: call.call_id,
          name: tool.name,
          decision: "allow",
          reason: "escalated out of sandbox by user",
        });
        try {
          result = await run(false);
        } catch (e) {
          result = fail(`${tool.name} failed: ${(e as Error).message}`, "unknown");
        }
      }
    }
    return done(result, decision, risk, args);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, ac?: AbortController): Promise<T> {
  if (!ms) return p;
  return new Promise((res, rej) => {
    const t = setTimeout(() => {
      ac?.abort();
      rej(new Error(`timed out after ${ms}ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        res(v);
      },
      (e) => {
        clearTimeout(t);
        rej(e);
      },
    );
  });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n…[${s.length - max} chars omitted]…\n${s.slice(-half)}`;
}

function redact(args: any): unknown {
  if (!args || typeof args !== "object") return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args))
    out[k] = typeof v === "string" && v.length > 400 ? v.slice(0, 400) + `…(${v.length} chars)` : v;
  return out;
}
