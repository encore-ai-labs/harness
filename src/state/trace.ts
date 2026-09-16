/**
 * Trace: an append-only JSONL log of everything that happened in a run.
 *
 * Why: "Observe the run, not just the final answer." A clean final diff can hide
 * a terrible process (ignored failures, retried external actions, ten times the
 * budget). The trace makes every run reconstructable, and it is the raw material
 * for the change receipt: the receipt only claims what the trace can prove.
 *
 * Events are plain objects with a `t` (ISO time) and `ev` (event name). Keep
 * payloads small; large tool outputs live in the session messages, not here.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type TraceEvent =
  | {
      ev: "session.start";
      sessionId: string;
      cwd: string;
      model: string;
      mode: string;
      resumed: boolean;
    }
  | { ev: "session.end"; reason: string; turns: number; costUsd: number }
  | { ev: "contract.created"; contract: unknown }
  | { ev: "context.loaded"; sources: string[]; chars: number }
  | { ev: "user.message"; chars: number; images?: number }
  | { ev: "model.request"; turn: number; model: string; messages: number; approxTokens: number }
  | {
      ev: "model.response";
      turn: number;
      ms: number;
      usage: unknown;
      costUsd: number;
      toolCalls: number;
      finish: string;
      ttftMs?: number;
      cachedFraction?: number;
      toolMs?: number;
    }
  | { ev: "model.retry"; attempt: number; reason: string; waitMs: number }
  | { ev: "tool.proposed"; turn: number; id: string; name: string; args: unknown; risk: string }
  | { ev: "tool.decision"; id: string; name: string; decision: string; reason: string }
  | {
      ev: "tool.result";
      id: string;
      name: string;
      ok: boolean;
      ms: number;
      evidence?: unknown;
      changed?: string[];
      error?: string;
      failureClass?: string;
    }
  | { ev: "policy.blocked"; name: string; reason: string }
  | { ev: "failure.repeated"; name: string; count: number }
  | { ev: "budget.exceeded"; budget: string; value: number; limit: number }
  | { ev: "checkpoint"; sha: string; label: string; turn: number; files: number }
  | { ev: "rewind"; sha: string }
  | { ev: "state.updated"; keys: string[] }
  | { ev: "plan.updated"; steps: number; done: number }
  | { ev: "context.pruned"; removedChars: number; messages: number }
  | { ev: "context.compacted"; beforeTokens: number; afterTokens: number }
  | { ev: "verify.check"; name: string; command: string; ok: boolean; ms: number; tail: string }
  | { ev: "verify.verdict"; round: number; verdict: string; findings: unknown }
  | { ev: "receipt"; receipt: unknown }
  | { ev: "handoff.written"; path: string }
  | { ev: "note"; text: string };

export class Trace {
  private events: Array<TraceEvent & { t: string }> = [];
  constructor(public readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  static load(path: string): Trace {
    const t = new Trace(path);
    if (!existsSync(path)) return t;
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        t.events.push(JSON.parse(line));
      } catch {
        break;
      }
    }
    return t;
  }

  log(e: TraceEvent) {
    const rec = { t: new Date().toISOString(), ...e };
    this.events.push(rec);
    try {
      appendFileSync(this.path, JSON.stringify(rec) + "\n");
    } catch {
      /* never let tracing break the run */
    }
  }

  /** In-memory view for this process (the receipt compiler reads this). */
  all(): ReadonlyArray<TraceEvent & { t: string }> {
    return this.events;
  }

  filter<K extends TraceEvent["ev"]>(ev: K): Array<Extract<TraceEvent, { ev: K }> & { t: string }> {
    return this.events.filter((e) => e.ev === ev) as any;
  }
}
