/** glob: find files by pattern, newest first, capped. */
import { statSync } from "node:fs";
import { join } from "node:path";
import { type ToolDefinition, fail, ok } from "./types.ts";
import { resolveInWorkspace } from "./paths.ts";

interface Args {
  pattern: string;
  path?: string;
}
const MAX = 300;

export const globTool: ToolDefinition<Args> = {
  name: "glob",
  description:
    'Find files matching a glob pattern (e.g. "src/**/*.ts", "**/test_*.py"). Returns paths relative to the workspace, ' +
    "most recently modified first, max 300. node_modules, .git and build output are skipped.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern." },
      path: { type: "string", description: "Directory to search in (default: workspace root)." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  risk: () => "read",
  summarize: (a) => a.pattern + (a.path ? ` in ${a.path}` : ""),
  async execute(a, ctx) {
    const r = resolveInWorkspace(ctx.cwd, a.path ?? ".");
    if ("error" in r) return fail(r.error, "invalid_args");
    const g = new Bun.Glob(a.pattern);
    const found: Array<{ p: string; m: number }> = [];
    try {
      for await (const p of g.scan({ cwd: r.abs, dot: false, onlyFiles: true })) {
        if (/(^|\/)(node_modules|\.git|\.harness|dist|build|target|\.venv)(\/|$)/.test(p)) continue;
        let m = 0;
        try {
          m = statSync(join(r.abs, p)).mtimeMs;
        } catch {
          /* ignore */
        }
        found.push({ p: r.rel === "." ? p : join(r.rel, p), m });
        if (found.length > 5000) break;
      }
    } catch (e) {
      return fail(`glob failed: ${(e as Error).message}`, "invalid_args");
    }
    found.sort((x, y) => y.m - x.m);
    const shown = found.slice(0, MAX);
    const out = shown.map((f) => f.p).join("\n") || "(no matches)";
    const more = found.length > MAX ? `\n[${found.length - MAX} more; narrow the pattern]` : "";
    return ok(out + more, {
      evidence: { pattern: a.pattern, matches: found.length },
      summary: `${found.length} matches`,
    });
  },
};
