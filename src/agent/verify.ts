/**
 * Off-gateway checks plus a verifier model that never sees the worker history.
 * Inconclusive is not a pass. Skip when no files changed.
 */
import { askJson, type HelperHost } from "./ask.ts";
import type { FunctionCallItem } from "../provider/types.ts";
import type { ToolGateway } from "../tools/index.ts";
import type { ToolContext } from "../tools/types.ts";
import type { Contract } from "./contract.ts";
import type { Trace } from "../state/trace.ts";

export interface CheckResult {
  name: string;
  command: string;
  ok: boolean;
  ms: number;
  tail: string;
}

export interface Verdict {
  verdict: "pass" | "reject" | "inconclusive";
  findings: string[];
  checks: CheckResult[];
}

const VERDICT_SCHEMA = {
  name: "verdict",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "findings"],
    properties: {
      verdict: { type: "string", enum: ["pass", "reject", "inconclusive"] },
      findings: { type: "array", items: { type: "string" } },
    },
  },
};

export async function runChecks(
  gateway: ToolGateway,
  ctx: ToolContext,
  checks: Array<{ name: string; command: string }>,
  trace: Trace,
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  let n = 0;
  for (const c of checks) {
    n++;
    const call: FunctionCallItem = {
      type: "function_call",
      call_id: `verify-${n}`,
      name: "bash",
      arguments: JSON.stringify({ command: c.command, description: c.name, timeout_ms: 120_000 }),
      meta: { kind: "verify" },
    };
    const outcome = await gateway.call(call, ctx);
    const tail = outcome.result.output.slice(-800);
    const row: CheckResult = {
      name: c.name,
      command: c.command,
      ok: outcome.result.ok,
      ms: outcome.ms,
      tail,
    };
    out.push(row);
    trace.log({
      ev: "verify.check",
      name: c.name,
      command: c.command,
      ok: row.ok,
      ms: row.ms,
      tail,
    });
  }
  return out;
}

export async function verify(
  rt: HelperHost & { gateway: ToolGateway; contract: Contract | null },
  opts: { diff: string; claim: string; ctx: ToolContext },
): Promise<Verdict> {
  const checks: Array<{ name: string; command: string }> = [...(rt.contract?.checks ?? [])];
  for (const [name, command] of Object.entries(rt.map.commands)) {
    if (
      ["test", "typecheck", "lint"].includes(name) &&
      !checks.some((c) => c.command === command)
    ) {
      checks.push({ name, command: command.split("#")[0]!.trim() });
    }
  }
  const results = await runChecks(rt.gateway, opts.ctx, checks, rt.trace);
  const failed = results.filter((r) => !r.ok);
  let parsed: { verdict: Verdict["verdict"]; findings: string[] };
  try {
    parsed = await askJson<{ verdict: Verdict["verdict"]; findings: string[] }>(rt, {
      model: rt.cfg.verifierModel,
      schema: VERDICT_SCHEMA,
      parse: (raw) => {
        if (!raw || typeof raw !== "object") return { error: "expected object" };
        const o = raw as { verdict?: string; findings?: string[] };
        if (o.verdict !== "pass" && o.verdict !== "reject" && o.verdict !== "inconclusive")
          return { error: "bad verdict" };
        return { verdict: o.verdict, findings: Array.isArray(o.findings) ? o.findings : [] };
      },
      instructions:
        "You are an adversarial verifier. You do not see the worker transcript. Pass only if the diff and checks prove the claim. " +
        "If checks failed, reject. If evidence is missing, inconclusive — that is not a pass. JSON only.",
      input: [
        rt.contract ? `contract:\n${JSON.stringify(rt.contract)}` : "no contract",
        `claim:\n${opts.claim.slice(0, 2000)}`,
        `diff (capped):\n${opts.diff.slice(0, 12_000) || "(empty)"}`,
        `checks:\n${results.map((r) => `${r.ok ? "PASS" : "FAIL"} ${r.name} (${r.ms}ms)\n${r.tail}`).join("\n\n")}`,
      ].join("\n\n"),
    });
  } catch (e) {
    parsed = { verdict: "inconclusive", findings: [`verifier error: ${(e as Error).message}`] };
  }
  if (failed.length && parsed.verdict === "pass")
    parsed = {
      verdict: "reject",
      findings: [...parsed.findings, "checks failed; pass is not allowed"],
    };
  const verdict: Verdict = { verdict: parsed.verdict, findings: parsed.findings, checks: results };
  rt.trace.log({
    ev: "verify.verdict",
    round: opts.ctx.turn,
    verdict: verdict.verdict,
    findings: verdict.findings,
  });
  return verdict;
}
