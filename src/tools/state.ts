/**
 * update_state and update_plan: the model's write access to durable memory.
 *
 * These are the long-horizon backbone. The plan is the model's own todo list
 * (rendered into every prompt); state is what survives compaction and sessions.
 * The harness nudges the model to use them (see agent/loop.ts reminders) and
 * forces a state compile before compaction, but the model owns the content.
 */
import type { PlanStep } from "../state/store.ts";
import { type ToolDefinition, fail, ok } from "./types.ts";

interface StateArgs {
  facts?: string[];
  decisions?: Array<{ text: string; reason: string }>;
  lessons?: string[];
  retract?: string[];
}

export const updateStateTool: ToolDefinition<StateArgs> = {
  name: "update_state",
  description:
    "Record durable knowledge that must survive context loss and future sessions. Use it as soon as you learn something " +
    "stable (facts: where things live, how to run things), whenever you make a non-obvious choice (decisions + reason), and " +
    "after any failure that should change future behaviour (lessons). Keep entries short and specific. Do not record transient progress here; use update_plan.",
  parameters: {
    type: "object",
    properties: {
      facts: {
        type: "array",
        items: { type: "string" },
        description: "Stable facts about the environment/codebase.",
      },
      decisions: {
        type: "array",
        items: {
          type: "object",
          properties: { text: { type: "string" }, reason: { type: "string" } },
          required: ["text", "reason"],
          additionalProperties: false,
        },
        description: "Choices made and why.",
      },
      lessons: {
        type: "array",
        items: { type: "string" },
        description: "What a failure taught you; phrased as a rule for next time.",
      },
      retract: {
        type: "array",
        items: { type: "string" },
        description: "Exact text of entries that are now wrong and should be removed.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  risk: () => "read",
  access: () => "write",
  summarize: (a) =>
    [
      a.facts?.length && `${a.facts.length} facts`,
      a.decisions?.length && `${a.decisions.length} decisions`,
      a.lessons?.length && `${a.lessons.length} lessons`,
      a.retract?.length && `${a.retract.length} retracted`,
    ]
      .filter(Boolean)
      .join(", ") || "no-op",
  async execute(a, ctx) {
    const touched = ctx.state.update(a);
    if (!touched.length)
      return fail(
        "nothing to update: provide facts, decisions, lessons or retract",
        "invalid_args",
      );
    ctx.trace.log({ ev: "state.updated", keys: touched });
    const s = ctx.state.get();
    return ok(
      `state updated (${touched.join(", ")}). Totals: ${s.facts.length} facts, ${s.decisions.length} decisions, ${s.lessons.length} lessons.`,
      {
        evidence: { touched },
        summary: touched.join(", "),
      },
    );
  },
};

interface PlanArgs {
  steps: PlanStep[];
}

export const updatePlanTool: ToolDefinition<PlanArgs> = {
  name: "update_plan",
  description:
    "Create or update your step-by-step plan for the current task. Call it at the start of any task with more than one step, " +
    "and again whenever a step changes status. Exactly one step should be in_progress at a time. Mark a step done only when " +
    "you have evidence (a test ran, a file exists), and put that evidence in `note`. Blocked steps must say why in `note`. " +
    "Replaces the whole plan each time, so include all steps.",
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: 'Short stable id, e.g. "1", "2a".' },
            title: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "done", "blocked"] },
            note: {
              type: "string",
              description: "Evidence for done, reason for blocked, or nothing.",
            },
          },
          required: ["id", "title", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["steps"],
    additionalProperties: false,
  },
  risk: () => "read",
  access: () => "write",
  summarize: (a) => {
    const st = a.steps ?? [];
    return (
      `${st.filter((s) => s.status === "done").length}/${st.length} done` +
      (st.find((s) => s.status === "in_progress")
        ? `, now: ${st.find((s) => s.status === "in_progress")?.title}`
        : "")
    );
  },
  precondition: (a) => {
    if (!Array.isArray(a.steps) || a.steps.length === 0) return "steps must be a non-empty array";
    const active = a.steps.filter((s) => s.status === "in_progress").length;
    if (active > 1) return `only one step may be in_progress (got ${active})`;
    const ids = new Set<string>();
    for (const s of a.steps) {
      if (ids.has(s.id)) return `duplicate step id ${s.id}`;
      ids.add(s.id);
      if (s.status === "done" && !s.note?.trim())
        return `step ${s.id} is done but has no note; name the evidence (test output, file path)`;
    }
    return null;
  },
  async execute(a, ctx) {
    ctx.state.setPlan(
      a.steps.map((s) => ({
        id: String(s.id),
        title: s.title,
        status: s.status,
        ...(s.note ? { note: s.note } : {}),
      })),
    );
    const c = ctx.state.planCounts();
    ctx.trace.log({ ev: "plan.updated", steps: c.total, done: c.done });
    return ok(
      `plan updated: ${c.done}/${c.total} done, ${c.active} active, ${c.blocked} blocked\n${ctx.state.renderPlanForPrompt()}`,
      {
        evidence: c,
        summary: `${c.done}/${c.total} done`,
      },
    );
  },
};
