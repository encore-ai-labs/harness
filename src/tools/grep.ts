/**
 * grep: search file contents with ripgrep if available, else a pure-JS fallback.
 * Output is `path:line: text`, capped, so results never flood context.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ToolDefinition, fail, ok } from "./types.ts";
import { resolveInWorkspace } from "./paths.ts";

interface Args {
  pattern: string;
  path?: string;
  include?: string;
  ignore_case?: boolean;
  max_results?: number;
}

let rgPath: string | null | undefined;
function findRg(): string | null {
  if (rgPath !== undefined) return rgPath;
  rgPath = Bun.which("rg");
  return rgPath;
}

export const grepTool: ToolDefinition<Args> = {
  name: "grep",
  description:
    "Search file contents for a regular expression. Returns `path:line: text` matches (max 200 by default). " +
    'Use `include` to filter by file glob (e.g. "*.ts"). Prefer this over bash grep/rg.',
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression (ripgrep/Rust syntax)." },
      path: {
        type: "string",
        description: "File or directory to search (default: workspace root).",
      },
      include: {
        type: "string",
        description: 'Only search files matching this glob, e.g. "*.py" or "src/**/*.ts".',
      },
      ignore_case: { type: "boolean" },
      max_results: { type: "integer", description: "Cap on matches (default 200)." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  risk: () => "read",
  summarize: (a) =>
    `/${a.pattern}/${a.include ? ` in ${a.include}` : ""}${a.path ? ` at ${a.path}` : ""}`,
  async execute(a, ctx) {
    const r = resolveInWorkspace(ctx.cwd, a.path ?? ".");
    if ("error" in r) return fail(r.error, "invalid_args");
    if (!existsSync(r.abs)) return fail(`${a.path} does not exist`, "not_found");
    const max = Math.min(1000, Math.max(1, a.max_results ?? 200));
    const rg = findRg();
    let lines: string[] = [];
    if (rg) {
      const args = [
        rg,
        "-n",
        "--no-heading",
        "--color=never",
        "-M",
        "400",
        "--max-count",
        String(max),
      ];
      if (a.ignore_case) args.push("-i");
      if (a.include) args.push("-g", a.include);
      args.push(
        "-g",
        "!node_modules",
        "-g",
        "!.git",
        "-g",
        "!.harness",
        "-e",
        a.pattern,
        r.rel === "." ? "." : r.rel,
      );
      const p = Bun.spawn(args, { cwd: ctx.cwd, stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      const code = await p.exited;
      if (code === 2) return fail(`grep error: ${err.trim().slice(0, 500)}`, "invalid_args");
      lines = out.split("\n").filter(Boolean);
    } else {
      // Fallback: walk files ourselves. Slow on big trees but dependency-free.
      let re: RegExp;
      try {
        re = new RegExp(a.pattern, a.ignore_case ? "i" : "");
      } catch (e) {
        return fail(`invalid regex: ${(e as Error).message}`, "invalid_args");
      }
      const g = new Bun.Glob(a.include ?? "**/*");
      const base = statSync(r.abs).isDirectory() ? r.abs : ctx.cwd;
      for await (const p of g.scan({ cwd: base, onlyFiles: true, dot: false })) {
        if (/(^|\/)(node_modules|\.git|\.harness)(\/|$)/.test(p)) continue;
        let text: string;
        try {
          const b = readFileSync(join(base, p));
          if (b.subarray(0, 4000).includes(0)) continue;
          text = b.toString("utf8");
        } catch {
          continue;
        }
        const ls = text.split("\n");
        for (let i = 0; i < ls.length && lines.length < max; i++)
          if (re.test(ls[i] ?? "")) lines.push(`${p}:${i + 1}: ${(ls[i] ?? "").slice(0, 400)}`);
        if (lines.length >= max) break;
      }
    }
    const capped = lines.slice(0, max);
    const out = capped.join("\n") || "(no matches)";
    const more = lines.length > max ? `\n[capped at ${max}; narrow the pattern or path]` : "";
    return ok(out + more, {
      evidence: { pattern: a.pattern, matches: capped.length, engine: rg ? "rg" : "js" },
      summary: `${capped.length} matches`,
    });
  },
};
