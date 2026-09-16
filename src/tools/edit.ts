/**
 * edit: replace one occurrence of `old_string` with `new_string` in a file.
 *
 * Precondition, not prompt: `old_string` must match exactly once. If it matches
 * zero times we try progressively looser matchers (trailing whitespace, then
 * leading indentation) and report which one succeeded, so the model learns to
 * quote precisely. If it matches more than once the call is refused with the
 * count, and the model must add context or set `replace_all`.
 *
 * This is the same contract Claude Code and OpenCode use; it is far more
 * reliable than line-number edits, which drift as the file changes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { type ToolDefinition, fail, ok } from "./types.ts";
import { resolveInWorkspace } from "./paths.ts";

interface Args {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

type Matcher = { name: string; find: (hay: string, needle: string) => number[] };

function allIndexes(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) {
    out.push(i);
    i += needle.length;
  }
  return out;
}

/** Line-based fuzzy match: compares lines after applying `norm` to both sides; returns char offsets. */
function lineMatcher(name: string, norm: (l: string) => string): Matcher {
  return {
    name,
    find(hay, needle) {
      const hl = hay.split("\n");
      const nl = needle.split("\n");
      if (nl.length > hl.length) return [];
      const nn = nl.map(norm);
      const offsets: number[] = [];
      let pos = 0;
      const starts: number[] = hl.map((l) => {
        const s = pos;
        pos += l.length + 1;
        return s;
      });
      for (let i = 0; i + nl.length <= hl.length; i++) {
        let okk = true;
        for (let j = 0; j < nl.length; j++)
          if (norm(hl[i + j] ?? "") !== nn[j]) {
            okk = false;
            break;
          }
        if (okk) offsets.push(starts[i] ?? 0);
      }
      return offsets;
    },
  };
}

const MATCHERS: Matcher[] = [
  { name: "exact", find: allIndexes },
  lineMatcher("trailing-whitespace", (l) => l.replace(/\s+$/, "")),
  lineMatcher("indentation", (l) => l.trim()),
];

export function applyEdit(
  content: string,
  oldS: string,
  newS: string,
  replaceAll: boolean,
): { content: string; matcher: string; count: number } | { error: string } {
  for (const m of MATCHERS) {
    const idx = m.find(content, oldS);
    if (idx.length === 0) continue;
    if (idx.length > 1 && !replaceAll)
      return {
        error: `old_string matches ${idx.length} times (${m.name} match). Add surrounding context to make it unique, or set replace_all.`,
      };
    // For fuzzy matches, replace the matched span by line-count, preserving the file's own text elsewhere.
    const lines = oldS.split("\n").length;
    let out = "";
    let cursor = 0;
    for (const at of replaceAll ? idx : [idx[0] ?? 0]) {
      if (at < cursor) continue;
      let end = at;
      if (m.name === "exact") end = at + oldS.length;
      else {
        // span to the end of the Nth line from `at`
        let n = 0;
        end = at;
        while (n < lines && end < content.length) {
          const nl = content.indexOf("\n", end);
          if (nl < 0) {
            end = content.length;
            break;
          }
          end = nl;
          n++;
          if (n < lines) end++;
        }
      }
      out += content.slice(cursor, at) + newS;
      cursor = end;
    }
    out += content.slice(cursor);
    return { content: out, matcher: m.name, count: replaceAll ? idx.length : 1 };
  }
  return {
    error:
      "old_string not found in file (tried exact, trailing-whitespace and indentation-insensitive matching). Re-read the file and copy the text exactly.",
  };
}

export const editTool: ToolDefinition<Args> = {
  name: "edit",
  description:
    "Replace text in a file. `old_string` must match exactly one location (whitespace-tolerant); include enough surrounding " +
    "lines to make it unique. Read the file first. For multi-file or multi-hunk changes use `apply_patch`.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: {
        type: "string",
        description: "Text to find. Must be unique unless replace_all.",
      },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  risk: () => "reversible",
  summarize: (a) =>
    `${a.path}  −${(a.old_string ?? "").split("\n").length} +${(a.new_string ?? "").split("\n").length} lines`,
  precondition: (a, ctx) => {
    const r = resolveInWorkspace(ctx.cwd, a.path);
    if ("error" in r) return r.error;
    if (!a.old_string) return "old_string must not be empty (use write to create files)";
    if (a.old_string === a.new_string) return "old_string and new_string are identical";
    try {
      readFileSync(r.abs);
    } catch {
      return `${a.path} does not exist`;
    }
    return null;
  },
  async execute(a, ctx) {
    const r = resolveInWorkspace(ctx.cwd, a.path);
    if ("error" in r) return fail(r.error, "invalid_args");
    const content = readFileSync(r.abs, "utf8");
    const res = applyEdit(content, a.old_string, a.new_string, !!a.replace_all);
    if ("error" in res) return fail(res.error, "invalid_args");
    writeFileSync(r.abs, res.content);
    // Show the model the result in place so it can verify without a re-read.
    const at = res.content.indexOf(a.new_string);
    const pre = res.content.slice(0, Math.max(0, at)).split("\n").length;
    const snippet = res.content
      .split("\n")
      .slice(Math.max(0, pre - 3), pre + a.new_string.split("\n").length + 2)
      .map((l, i) => `${String(Math.max(1, pre - 2) + i).padStart(4)}│${l}`)
      .join("\n");
    return ok(
      `edited ${r.rel} (${res.count} replacement${res.count > 1 ? "s" : ""}, ${res.matcher} match)\n${snippet}`,
      {
        evidence: { path: r.rel, replacements: res.count, matcher: res.matcher },
        changed: [r.rel],
        summary: `${res.count} replacement (${res.matcher})`,
      },
    );
  },
};
