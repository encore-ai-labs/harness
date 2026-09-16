/**
 * write: create or overwrite a whole file. Reversible (checkpointed), but the
 * gateway records the previous size so the receipt can say "replaced 120 lines".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type ToolDefinition, fail, ok } from "./types.ts";
import { resolveInWorkspace } from "./paths.ts";

interface Args {
  path: string;
  content: string;
}

export const writeTool: ToolDefinition<Args> = {
  name: "write",
  description:
    "Create a new file or overwrite an existing one with the full content. For changes to existing files prefer `edit` " +
    "or `apply_patch` so you do not clobber content you have not read. Creates parent directories.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path inside the workspace." },
      content: { type: "string", description: "Complete file content." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  risk: () => "reversible",
  summarize: (a) => `${a.path} (${(a.content ?? "").length} chars)`,
  precondition: (a, ctx) => {
    const r = resolveInWorkspace(ctx.cwd, a.path);
    if ("error" in r) return r.error;
    if (typeof a.content !== "string") return "content must be a string";
    return null;
  },
  async execute(a, ctx) {
    const r = resolveInWorkspace(ctx.cwd, a.path);
    if ("error" in r) return fail(r.error, "invalid_args");
    const existed = existsSync(r.abs);
    const before = existed ? readFileSync(r.abs, "utf8").split("\n").length : 0;
    mkdirSync(dirname(r.abs), { recursive: true });
    writeFileSync(r.abs, a.content);
    const after = a.content.split("\n").length;
    return ok(
      `${existed ? "overwrote" : "created"} ${r.rel} (${after} lines${existed ? `, was ${before}` : ""})`,
      {
        evidence: { path: r.rel, created: !existed, linesBefore: before, linesAfter: after },
        changed: [r.rel],
        summary: existed ? "overwritten" : "created",
      },
    );
  },
};
