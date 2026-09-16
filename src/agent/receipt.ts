/**
 * Receipt: a pure fold over the trace. It may only claim events that exist.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "../state/session.ts";
import type { Trace, TraceEvent } from "../state/trace.ts";
import { fmtMs, fmtUsd } from "../cli/render.ts";

export function renderReceipt(session: Session, trace: Trace): string {
  const ev = trace.all();
  const lines: string[] = [];
  lines.push(`# Receipt ${session.id}`);
  lines.push("");
  lines.push(`- status: ${session.meta.status}`);
  lines.push(`- model: ${session.meta.model}`);
  lines.push(`- mode: ${session.meta.mode}`);
  lines.push(`- turns: ${session.meta.turns}`);
  lines.push(`- cost: ${fmtUsd(session.meta.costUsd)}`);
  if (session.meta.contract) lines.push(`- goal: ${session.meta.contract.goal}`);
  lines.push("");

  const ends = ev.filter((e) => e.ev === "session.end");
  if (ends[0]) lines.push(`Ended: ${ends[0].reason}`);

  const files = new Set<string>();
  const tools = ev.filter(
    (e): e is Extract<TraceEvent, { ev: "tool.result" }> & { t: string } => e.ev === "tool.result",
  );
  for (const t of tools) {
    const ch = t.changed ?? (t.evidence as { changed?: string[] } | undefined)?.changed;
    if (Array.isArray(ch)) for (const p of ch) files.add(p);
  }
  lines.push("## Files");
  if (files.size) lines.push([...files].map((f) => `- ${f}`).join("\n"));
  else lines.push("- (none recorded in the trace)");

  const cps = ev.filter((e) => e.ev === "checkpoint");
  if (cps.length) {
    lines.push("", "## Checkpoints");
    for (const c of cps) lines.push(`- ${c.sha} turn ${c.turn} ${c.label} (${c.files} files)`);
  }

  const blocked = ev.filter(
    (e) => e.ev === "policy.blocked" || (e.ev === "tool.decision" && e.decision === "deny"),
  );
  if (blocked.length) {
    lines.push("", "## APPROVAL NEEDED / blocked");
    for (const b of blocked) {
      if (b.ev === "policy.blocked") lines.push(`- ${b.name}: ${b.reason}`);
      else if (b.ev === "tool.decision") lines.push(`- ${b.name}: ${b.reason}`);
    }
  }

  const checks = ev.filter((e) => e.ev === "verify.check");
  const verdicts = ev.filter((e) => e.ev === "verify.verdict");
  if (checks.length || verdicts.length) {
    lines.push("", "## Verify");
    for (const c of checks)
      lines.push(`- ${c.ok ? "pass" : "fail"} ${c.name} \`${c.command}\` (${fmtMs(c.ms)})`);
    for (const v of verdicts)
      lines.push(`- verdict: ${v.verdict}${v.findings ? ` — ${JSON.stringify(v.findings)}` : ""}`);
  }

  const responses = ev.filter((e) => e.ev === "model.response");
  if (responses.length) {
    lines.push("", "## Model");
    for (const r of responses) {
      const cache = r.cachedFraction != null ? `${Math.round(r.cachedFraction * 100)}% cached` : "";
      lines.push(
        `- turn ${r.turn}: ${fmtMs(r.ms)} ttft ${r.ttftMs != null ? fmtMs(r.ttftMs) : "?"} tools ${r.toolMs != null ? fmtMs(r.toolMs) : "?"} ${cache} ${fmtUsd(r.costUsd)}`,
      );
    }
  }

  lines.push("", "_Every claim above is copied from trace.jsonl._");
  return lines.join("\n") + "\n";
}

export function writeReceipt(session: Session, trace: Trace): string {
  const md = renderReceipt(session, trace);
  const path = join(session.dir, "receipt.md");
  writeFileSync(path, md);
  trace.log({ ev: "receipt", receipt: { path, chars: md.length } });
  return md;
}
