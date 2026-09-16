/** ls: list a directory (one level), directories first, ignoring junk. */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ToolDefinition, fail, ok } from "./types.ts";
import { resolveInWorkspace } from "./paths.ts";

interface Args {
  path?: string;
}
const IGNORE = new Set(["node_modules", ".git", ".harness", ".DS_Store"]);

export const lsTool: ToolDefinition<Args> = {
  name: "ls",
  description:
    "List files and directories at a path (non-recursive). Use glob for recursive searches.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path (default: workspace root)." },
    },
    required: [],
    additionalProperties: false,
  },
  risk: () => "read",
  summarize: (a) => a.path ?? ".",
  async execute(a, ctx) {
    const r = resolveInWorkspace(ctx.cwd, a.path ?? ".");
    if ("error" in r) return fail(r.error, "invalid_args");
    let entries: string[];
    try {
      entries = readdirSync(r.abs);
    } catch (e) {
      return fail(`cannot list ${a.path ?? "."}: ${(e as Error).message}`, "not_found");
    }
    const rows = entries
      .filter((e) => !IGNORE.has(e))
      .map((e) => {
        try {
          const st = statSync(join(r.abs, e));
          return { name: e, dir: st.isDirectory(), size: st.size };
        } catch {
          return { name: e, dir: false, size: 0 };
        }
      })
      .sort((x, y) => Number(y.dir) - Number(x.dir) || x.name.localeCompare(y.name));
    const out =
      rows.map((x) => (x.dir ? `${x.name}/` : `${x.name}  (${x.size} B)`)).join("\n") || "(empty)";
    return ok(out, {
      evidence: { path: r.rel, entries: rows.length },
      summary: `${rows.length} entries`,
    });
  },
};
