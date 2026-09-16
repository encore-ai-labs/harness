export interface Contract {
  goal: string;
  doneWhen: string[];
  checks: Array<{ name: string; command: string }>;
  constraints: string[];
  outOfScope: string[];
}

export const CONTRACT_SCHEMA = {
  name: "contract",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["goal", "doneWhen", "checks", "constraints", "outOfScope"],
    properties: {
      goal: { type: "string" },
      doneWhen: { type: "array", items: { type: "string" } },
      checks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "command"],
          properties: {
            name: { type: "string" },
            command: { type: "string" },
          },
        },
      },
      constraints: { type: "array", items: { type: "string" } },
      outOfScope: { type: "array", items: { type: "string" } },
    },
  },
};

export function parseContract(raw: unknown): Contract | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "contract must be an object" };
  const o = raw as Record<string, unknown>;
  if (typeof o.goal !== "string" || !o.goal.trim()) return { error: "goal is required" };
  const strs = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const checks = Array.isArray(o.checks)
    ? o.checks
        .filter((c): c is { name: unknown; command: unknown } => !!c && typeof c === "object")
        .filter((c) => typeof c.name === "string" && typeof c.command === "string")
        .map((c) => ({ name: c.name as string, command: c.command as string }))
    : [];
  return {
    goal: o.goal,
    doneWhen: strs(o.doneWhen),
    checks,
    constraints: strs(o.constraints),
    outOfScope: strs(o.outOfScope),
  };
}

export function renderContract(c: Contract): string {
  const lines = [`goal: ${c.goal}`];
  if (c.doneWhen.length) lines.push(`done when:\n${c.doneWhen.map((x) => `- ${x}`).join("\n")}`);
  if (c.checks.length)
    lines.push(`checks:\n${c.checks.map((x) => `- ${x.name}: ${x.command}`).join("\n")}`);
  if (c.constraints.length)
    lines.push(`constraints:\n${c.constraints.map((x) => `- ${x}`).join("\n")}`);
  if (c.outOfScope.length)
    lines.push(`out of scope:\n${c.outOfScope.map((x) => `- ${x}`).join("\n")}`);
  return lines.join("\n\n");
}

export function wantsContract(mode: "auto" | "always" | "never", interactive: boolean): boolean {
  if (mode === "never") return false;
  if (mode === "always") return true;
  return !interactive;
}
