/**
 * Durable state: the harness's memory that survives context loss.
 *
 * Why: conversation history is an event stream, not memory. For long-horizon
 * work the model will lose its context window several times over. What must
 * survive is not the transcript but four compiled things:
 *
 *   FACTS      stable things discovered about the environment
 *   DECISIONS  choices made and the reason behind them
 *   PROGRESS   completed / active / blocked / remaining (the plan, see below)
 *   LESSONS    failures that should change future behaviour
 *
 * The model writes these through the `update_state` tool; the harness also
 * forces a compile before compaction. State lives at .harness/state.json in the
 * project so it is shared across sessions: the next session starts from state,
 * not from "here is the conversation".
 *
 * The plan is a separate file (.harness/plan.json) because it changes far more
 * often than durable state. After compact, the reminder re-injects it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Fact {
  text: string;
  ts: string;
  session: string;
}
export interface Decision {
  text: string;
  reason: string;
  ts: string;
  session: string;
}
export interface Lesson {
  text: string;
  ts: string;
  session: string;
}

export interface DurableState {
  facts: Fact[];
  decisions: Decision[];
  lessons: Lesson[];
  updatedAt: string;
}

export type StepStatus = "pending" | "in_progress" | "done" | "blocked";
export interface PlanStep {
  id: string;
  title: string;
  status: StepStatus;
  /** Free-form note: why blocked, what evidence proves done, etc. */
  note?: string;
}
export interface Plan {
  steps: PlanStep[];
  updatedAt: string;
  session: string;
}

const EMPTY_STATE: DurableState = { facts: [], decisions: [], lessons: [], updatedAt: "" };
const EMPTY_PLAN: Plan = { steps: [], updatedAt: "", session: "" };

function readJsonOr<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return { ...fallback, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return fallback;
  }
}

function writeJson(path: string, v: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(v, null, 2) + "\n");
}

export class StateStore {
  readonly statePath: string;
  readonly planPath: string;
  private state: DurableState;
  private plan: Plan;

  constructor(
    readonly cwd: string,
    readonly sessionId: string,
  ) {
    this.statePath = join(cwd, ".harness", "state.json");
    this.planPath = join(cwd, ".harness", "plan.json");
    this.state = readJsonOr(this.statePath, EMPTY_STATE);
    this.plan = readJsonOr(this.planPath, EMPTY_PLAN);
  }

  get(): DurableState {
    return this.state;
  }
  getPlan(): Plan {
    return this.plan;
  }

  /** Append-only update; the model never rewrites history, it adds to it. */
  update(input: {
    facts?: string[];
    decisions?: Array<{ text: string; reason: string }>;
    lessons?: string[];
    /** Remove entries whose text matches exactly (facts/decisions/lessons). */
    retract?: string[];
  }): string[] {
    const ts = new Date().toISOString();
    const touched: string[] = [];
    const s = this.state;
    if (input.retract?.length) {
      const set = new Set(input.retract.map((t) => t.trim()));
      s.facts = s.facts.filter((f) => !set.has(f.text.trim()));
      s.decisions = s.decisions.filter((d) => !set.has(d.text.trim()));
      s.lessons = s.lessons.filter((l) => !set.has(l.text.trim()));
      touched.push("retract");
    }
    for (const t of input.facts ?? []) {
      if (t.trim() && !s.facts.some((f) => f.text === t))
        s.facts.push({ text: t, ts, session: this.sessionId });
      touched.push("facts");
    }
    for (const d of input.decisions ?? []) {
      if (d.text?.trim())
        s.decisions.push({ text: d.text, reason: d.reason ?? "", ts, session: this.sessionId });
      touched.push("decisions");
    }
    for (const t of input.lessons ?? []) {
      if (t.trim() && !s.lessons.some((l) => l.text === t))
        s.lessons.push({ text: t, ts, session: this.sessionId });
      touched.push("lessons");
    }
    s.updatedAt = ts;
    writeJson(this.statePath, s);
    return [...new Set(touched)];
  }

  /** Replace the plan wholesale: the model owns the plan, the harness owns its persistence. */
  setPlan(steps: PlanStep[]): Plan {
    this.plan = { steps, updatedAt: new Date().toISOString(), session: this.sessionId };
    writeJson(this.planPath, this.plan);
    return this.plan;
  }

  /** Compact text rendering for the system prompt. Bounded so it can never flood context. */
  renderForPrompt(opts: { maxItems?: number } = {}): string {
    const max = opts.maxItems ?? 25;
    const s = this.state;
    const parts: string[] = [];
    const list = (title: string, items: string[]) => {
      if (!items.length) return;
      const shown = items.slice(-max);
      parts.push(
        `${title}${items.length > max ? ` (last ${max} of ${items.length})` : ""}:\n` +
          shown.map((i) => `- ${i}`).join("\n"),
      );
    };
    list(
      "FACTS",
      s.facts.map((f) => f.text),
    );
    list(
      "DECISIONS",
      s.decisions.map((d) => (d.reason ? `${d.text} (reason: ${d.reason})` : d.text)),
    );
    list(
      "LESSONS",
      s.lessons.map((l) => l.text),
    );
    return parts.join("\n\n");
  }

  renderPlanForPrompt(): string {
    if (!this.plan.steps.length) return "";
    const icon: Record<StepStatus, string> = {
      pending: "[ ]",
      in_progress: "[>]",
      done: "[x]",
      blocked: "[!]",
    };
    return this.plan.steps
      .map((st) => `${icon[st.status]} ${st.id}. ${st.title}${st.note ? ` — ${st.note}` : ""}`)
      .join("\n");
  }

  planCounts(): { total: number; done: number; blocked: number; active: number } {
    const st = this.plan.steps;
    return {
      total: st.length,
      done: st.filter((s) => s.status === "done").length,
      blocked: st.filter((s) => s.status === "blocked").length,
      active: st.filter((s) => s.status === "in_progress").length,
    };
  }
}
