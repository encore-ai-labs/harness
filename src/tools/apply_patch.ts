/**
 * apply_patch: multi-file edits in Codex's patch format.
 *
 *   *** Begin Patch
 *   *** Add File: path/new.ts
 *   +line
 *   +line
 *   *** Delete File: path/old.ts
 *   *** Update File: path/existing.ts
 *   *** Move to: path/renamed.ts        (optional)
 *   @@ def function_name():              (optional single-line context anchor)
 *    context line
 *   -removed line
 *   +added line
 *   *** End of File                      (optional: anchor the hunk at EOF)
 *   *** End Patch
 *
 * Semantics (from codex-rs/apply-patch): each `@@ text` names one line that must
 * appear after the previous hunk; the hunk's context+minus lines are then matched
 * as a contiguous block after that anchor and replaced with context+plus lines.
 * Matching degrades exact → trailing-whitespace → trimmed. Hunks apply in file
 * order. Errors are line-numbered so the model can repair the patch precisely.
 *
 * We expose it as a normal JSON function tool with a `patch` string; xAI's API
 * does not offer Codex's freeform-grammar tool type.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type ToolDefinition, fail, ok } from "./types.ts";
import { resolveInWorkspace } from "./paths.ts";

interface Args {
  patch: string;
}

type Chunk = { anchor: string | null; old: string[]; neu: string[]; eof: boolean; line: number };
type Op =
  | { kind: "add"; path: string; lines: string[]; line: number }
  | { kind: "delete"; path: string; line: number }
  | { kind: "update"; path: string; moveTo: string | null; chunks: Chunk[]; line: number };

export function parsePatch(text: string): Op[] {
  let lines = text.replace(/\r\n/g, "\n").split("\n");
  // Lenient: strip a heredoc wrapper and surrounding whitespace-only lines.
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  if (lines[0]?.match(/<<\s*['"]?EOF['"]?\s*$/)) {
    lines.shift();
    if (lines[lines.length - 1]?.trim() === "EOF") lines.pop();
  }
  if (lines[0]?.trim() !== "*** Begin Patch")
    throw new Error(`line 1: patch must start with "*** Begin Patch"`);
  if (lines[lines.length - 1]?.trim() !== "*** End Patch")
    throw new Error(`line ${lines.length}: patch must end with "*** End Patch"`);
  const ops: Op[] = [];
  let i = 1;
  const last = lines.length - 1;
  const at = (n: number) => `line ${n + 1}`;
  while (i < last) {
    const l = lines[i]!;
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^\*\*\* Add File:\s*(.+)$/))) {
      const op: Op = { kind: "add", path: m[1]!.trim(), lines: [], line: i + 1 };
      i++;
      while (i < last && !lines[i]!.startsWith("*** ")) {
        const a = lines[i]!;
        if (!a.startsWith("+"))
          throw new Error(`${at(i)}: lines of an added file must start with "+"`);
        op.lines.push(a.slice(1));
        i++;
      }
      ops.push(op);
    } else if ((m = l.match(/^\*\*\* Delete File:\s*(.+)$/))) {
      ops.push({ kind: "delete", path: m[1]!.trim(), line: i + 1 });
      i++;
    } else if ((m = l.match(/^\*\*\* Update File:\s*(.+)$/))) {
      const op: Op = { kind: "update", path: m[1]!.trim(), moveTo: null, chunks: [], line: i + 1 };
      i++;
      if ((m = lines[i]?.match(/^\*\*\* Move to:\s*(.+)$/) ?? null)) {
        op.moveTo = m[1]!.trim();
        i++;
      }
      let chunk: Chunk | null = null;
      const push = () => {
        if (chunk && (chunk.old.length || chunk.neu.length || chunk.anchor !== null))
          op.chunks.push(chunk);
        chunk = null;
      };
      while (i < last && !/^\*\*\* (Add|Delete|Update) File:/.test(lines[i]!)) {
        const c = lines[i]!;
        if (c.startsWith("@@")) {
          push();
          chunk = {
            anchor: c.length > 2 ? c.slice(2).replace(/^ /, "") : null,
            old: [],
            neu: [],
            eof: false,
            line: i + 1,
          };
          if (chunk.anchor === "") chunk.anchor = null;
        } else if (c.trim() === "*** End of File") {
          if (!chunk) chunk = { anchor: null, old: [], neu: [], eof: true, line: i + 1 };
          chunk.eof = true;
          push();
        } else if (c.startsWith("+") || c.startsWith("-") || c.startsWith(" ") || c === "") {
          if (!chunk) chunk = { anchor: null, old: [], neu: [], eof: false, line: i + 1 };
          const body = c.slice(1);
          if (c.startsWith("+")) chunk.neu.push(body);
          else if (c.startsWith("-")) chunk.old.push(body);
          else {
            chunk.old.push(c === "" ? "" : body);
            chunk.neu.push(c === "" ? "" : body);
          }
        } else {
          throw new Error(
            `${at(i)}: unexpected line in update hunk: ${JSON.stringify(c.slice(0, 60))} (lines must start with ' ', '+', '-' or '@@')`,
          );
        }
        i++;
      }
      push();
      if (!op.chunks.length && !op.moveTo)
        throw new Error(`${at(op.line - 1)}: Update File has no hunks`);
      ops.push(op);
    } else if (!l.trim()) {
      i++;
    } else {
      throw new Error(
        `${at(i)}: expected "*** Add File:", "*** Delete File:" or "*** Update File:", got ${JSON.stringify(l.slice(0, 60))}`,
      );
    }
  }
  if (!ops.length) throw new Error("patch contains no operations");
  return ops;
}

export function patchPaths(text: string): string[] {
  try {
    return [
      ...new Set(
        parsePatch(text).flatMap((op) =>
          op.kind === "update" && op.moveTo ? [op.path, op.moveTo] : [op.path],
        ),
      ),
    ];
  } catch {
    return [];
  }
}

const norms: Array<(s: string) => string> = [
  (s) => s,
  (s) => s.replace(/\s+$/, ""),
  (s) => s.trim(),
];

function seek(hay: string[], needle: string[], from: number, eof: boolean): number {
  if (needle.length === 0) return from;
  if (eof) {
    const start = hay.length - needle.length;
    for (const n of norms)
      if (start >= from && needle.every((l, j) => n(hay[start + j] ?? "") === n(l))) return start;
    return -1;
  }
  for (const n of norms) {
    for (let i = from; i + needle.length <= hay.length; i++) {
      let okk = true;
      for (let j = 0; j < needle.length; j++)
        if (n(hay[i + j] ?? "") !== n(needle[j]!)) {
          okk = false;
          break;
        }
      if (okk) return i;
    }
  }
  return -1;
}

export function applyUpdate(content: string, chunks: Chunk[], path: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let pos = 0; // next unconsumed line in `lines`
  for (const ch of chunks) {
    let searchFrom = pos;
    if (ch.anchor !== null) {
      const a = seek(lines, [ch.anchor], pos, false);
      if (a < 0)
        throw new Error(
          `${path}: failed to find context "@@ ${ch.anchor}" (hunk at patch line ${ch.line})`,
        );
      searchFrom = a + 1;
    }
    const idx = seek(lines, ch.old, searchFrom, ch.eof);
    if (idx < 0) {
      const preview = ch.old
        .slice(0, 3)
        .map((l) => JSON.stringify(l))
        .join(", ");
      throw new Error(
        `${path}: failed to find hunk context starting ${preview} (hunk at patch line ${ch.line}). Re-read the file and copy lines exactly.`,
      );
    }
    out.push(...lines.slice(pos, idx));
    out.push(...ch.neu);
    pos = idx + ch.old.length;
  }
  out.push(...lines.slice(pos));
  return out.join("\n");
}

export const applyPatchTool: ToolDefinition<Args> = {
  name: "apply_patch",
  description:
    "Apply a multi-file patch in this exact format:\n" +
    "*** Begin Patch\n*** Add File: path/new.ts\n+first line\n+second line\n*** Delete File: path/old.ts\n*** Update File: path/file.ts\n" +
    "*** Move to: path/renamed.ts   (optional)\n@@ unique line near the change   (optional anchor)\n context line\n-removed line\n+added line\n*** End Patch\n" +
    "Context lines start with a space, removed with '-', added with '+'. Use '*** End of File' to anchor a hunk at the end. " +
    "Hunks must be in file order and context must match the file (whitespace-tolerant). Prefer `edit` for a single small replacement.",
  parameters: {
    type: "object",
    properties: {
      patch: {
        type: "string",
        description: "The full patch text, from *** Begin Patch to *** End Patch.",
      },
    },
    required: ["patch"],
    additionalProperties: false,
  },
  risk: (a) => (/^\*\*\* Delete File:/m.test(a.patch ?? "") ? "reversible" : "reversible"),
  summarize: (a) => {
    try {
      const ops = parsePatch(a.patch);
      return ops
        .map((o) => `${o.kind} ${o.path}${o.kind === "update" && o.moveTo ? ` → ${o.moveTo}` : ""}`)
        .join(", ");
    } catch {
      return "(unparsable patch)";
    }
  },
  precondition: (a, ctx) => {
    let ops: Op[];
    try {
      ops = parsePatch(a.patch ?? "");
    } catch (e) {
      return `invalid patch: ${(e as Error).message}`;
    }
    for (const op of ops) {
      const r = resolveInWorkspace(ctx.cwd, op.path);
      if ("error" in r) return r.error;
      if (op.kind === "add" && existsSync(r.abs))
        return `${op.path} already exists; use Update File`;
      if (op.kind !== "add" && !existsSync(r.abs)) return `${op.path} does not exist`;
      if (op.kind === "update" && op.moveTo) {
        const m = resolveInWorkspace(ctx.cwd, op.moveTo);
        if ("error" in m) return m.error;
      }
    }
    return null;
  },
  async execute(a, ctx) {
    const ops = parsePatch(a.patch);
    // Dry-run everything first so a failing hunk leaves no partial write.
    const writes: Array<{ abs: string; rel: string; content: string | null; remove?: string }> = [];
    const summary: string[] = [];
    for (const op of ops) {
      const r = resolveInWorkspace(ctx.cwd, op.path) as { abs: string; rel: string };
      if (op.kind === "add") {
        writes.push({
          abs: r.abs,
          rel: r.rel,
          content: op.lines.join("\n") + (op.lines.length ? "\n" : ""),
        });
        summary.push(`A ${r.rel} (+${op.lines.length})`);
        continue;
      }
      if (op.kind === "delete") {
        writes.push({ abs: r.abs, rel: r.rel, content: null });
        summary.push(`D ${r.rel}`);
        continue;
      }
      const before = readFileSync(r.abs, "utf8");
      let after: string;
      try {
        after = applyUpdate(before, op.chunks, r.rel);
      } catch (e) {
        return fail((e as Error).message, "invalid_args");
      }
      const plus = op.chunks.reduce((n, c) => n + c.neu.length, 0),
        minus = op.chunks.reduce((n, c) => n + c.old.length, 0);
      if (op.moveTo) {
        const m = resolveInWorkspace(ctx.cwd, op.moveTo) as { abs: string; rel: string };
        writes.push({ abs: m.abs, rel: m.rel, content: after, remove: r.abs });
        summary.push(`R ${r.rel} → ${m.rel} (+${plus} −${minus})`);
      } else {
        writes.push({ abs: r.abs, rel: r.rel, content: after });
        summary.push(`M ${r.rel} (+${plus} −${minus})`);
      }
    }
    const changed: string[] = [];
    for (const w of writes) {
      if (w.content === null) {
        rmSync(w.abs);
        changed.push(w.rel);
        continue;
      }
      mkdirSync(dirname(w.abs), { recursive: true });
      writeFileSync(w.abs, w.content);
      changed.push(w.rel);
      if (w.remove) rmSync(w.remove);
    }
    return ok(`applied ${ops.length} operation(s):\n${summary.join("\n")}`, {
      evidence: { ops: summary },
      changed,
      summary: `${ops.length} ops`,
    });
  },
};
