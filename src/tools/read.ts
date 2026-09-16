/**
 * read: view a file with line numbers, optionally a range.
 *
 * Output is `N│ text` so the model can reference lines precisely when editing.
 * Large files are windowed (default 2000 lines) and binary files are refused;
 * the model must narrow rather than flood its own context.
 */
import { readFileSync, statSync } from "node:fs";
import { type ToolDefinition, fail, ok } from "./types.ts";
import { resolveInWorkspace } from "./paths.ts";

interface Args {
  path: string;
  offset?: number;
  limit?: number;
}

const MAX_LINE = 2000;

export const readTool: ToolDefinition<Args> = {
  name: "read",
  description:
    "Read a file from the workspace. Returns numbered lines. Use offset/limit to page through large files; " +
    "read only what you need. Prefer this over `cat` in bash. Fails on binary files and paths outside the workspace.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path, relative to the workspace root or absolute inside it.",
      },
      offset: { type: "integer", description: "1-based line to start from (default 1)." },
      limit: { type: "integer", description: "Max lines to return (default 2000)." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  risk: () => "read",
  summarize: (a) => a.path + (a.offset ? `:${a.offset}` : ""),
  precondition: (a, ctx) => {
    const r = resolveInWorkspace(ctx.cwd, a.path);
    if ("error" in r) return r.error;
    try {
      const st = statSync(r.abs);
      if (st.isDirectory()) return `${a.path} is a directory; use ls`;
      if (st.size > 20_000_000) return `${a.path} is ${st.size} bytes; too large to read`;
    } catch {
      return `${a.path} does not exist`;
    }
    return null;
  },
  async execute(a, ctx) {
    const r = resolveInWorkspace(ctx.cwd, a.path);
    if ("error" in r) return fail(r.error, "invalid_args");
    const buf = readFileSync(r.abs);
    if (buf.subarray(0, 8000).includes(0))
      return fail(`${a.path} looks binary; not shown`, "invalid_args");
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    const start = Math.max(1, a.offset ?? 1);
    const limit = Math.min(MAX_LINE, Math.max(1, a.limit ?? MAX_LINE));
    const slice = lines.slice(start - 1, start - 1 + limit);
    const width = String(start + slice.length).length;
    const body = slice
      .map(
        (l, i) =>
          `${String(start + i).padStart(width)}│${l.length > 2000 ? l.slice(0, 2000) + "…" : l}`,
      )
      .join("\n");
    const more =
      start - 1 + limit < lines.length
        ? `\n[${lines.length - (start - 1 + limit)} more lines; total ${lines.length}]`
        : "";
    return ok(body + more, {
      evidence: { path: r.rel, lines: lines.length, shown: slice.length },
      summary: `${slice.length} lines`,
    });
  },
};
