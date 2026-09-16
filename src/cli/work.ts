/**
 * Work-log shape. Coloring lives in render.ts so this file stays import-safe.
 */
import { basename } from "node:path";

export type WorkStatus = "run" | "ok" | "fail" | "denied" | "ask";

export interface WorkEvent {
  name: string;
  summary: string;
  status: WorkStatus;
  args?: Record<string, unknown>;
  output?: string;
  changed?: string[];
}

const OBSERVE = new Set(["read", "ls", "glob", "grep", "skill"]);

export function isObserve(name: string): boolean {
  return OBSERVE.has(name);
}

export function toolTitle(name: string): string {
  return (
    {
      read: "Read",
      ls: "Listed",
      glob: "Globbed",
      grep: "Grepped",
      skill: "Skill",
      bash: "Bash",
      write: "Wrote",
      edit: "Edited",
      apply_patch: "Edited",
      update_plan: "Plan",
      update_state: "State",
    }[name] ?? name
  );
}

export function workPath(ev: WorkEvent): string {
  const a = ev.args ?? {};
  const p = a.path ?? a.file ?? a.name ?? a.pattern ?? a.command;
  return typeof p === "string" && p ? p : ev.summary;
}

/** "Read, globbed, grepped 9 files, 2 globs, 1 grep" */
export function observeHeadline(events: WorkEvent[]): string {
  let reads = 0;
  let globs = 0;
  let greps = 0;
  let lists = 0;
  let skills = 0;
  for (const e of events) {
    if (e.name === "read") reads++;
    else if (e.name === "glob") globs++;
    else if (e.name === "grep") greps++;
    else if (e.name === "ls") lists++;
    else if (e.name === "skill") skills++;
  }
  const verbs: string[] = [];
  if (reads) verbs.push("Read");
  if (globs) verbs.push(verbs.length ? "globbed" : "Globbed");
  if (greps) verbs.push(verbs.length ? "grepped" : "Grepped");
  if (lists) verbs.push(verbs.length ? "listed" : "Listed");
  if (skills) verbs.push(verbs.length ? "loaded skill" : "Skill");
  const bits: string[] = [];
  if (reads) bits.push(`${reads} file${reads === 1 ? "" : "s"}`);
  if (globs) bits.push(`${globs} glob${globs === 1 ? "" : "s"}`);
  if (greps) bits.push(`${greps} grep${greps === 1 ? "" : "s"}`);
  if (lists) bits.push(`${lists} list${lists === 1 ? "" : "s"}`);
  if (skills) bits.push(`${skills} skill${skills === 1 ? "" : "s"}`);
  if (!verbs.length) return `${events.length} tool${events.length === 1 ? "" : "s"}`;
  return `${verbs.join(", ")} ${bits.join(", ")}`;
}

export function observeTail<T>(events: T[], keep = 4): { hidden: number; tail: T[] } {
  const hidden = Math.max(0, events.length - keep);
  return { hidden, tail: hidden ? events.slice(-keep) : events };
}

export function plusCount(text: string): number {
  return text ? text.split("\n").length : 0;
}

export function addedLines(ev: WorkEvent): {
  path: string;
  plus: number;
  lines: string[];
  hidden: number;
} {
  const a = ev.args ?? {};
  const path = String(a.path ?? ev.changed?.[0] ?? workPath(ev));
  let body = "";
  if (typeof a.new_string === "string") body = a.new_string;
  else if (typeof a.content === "string") body = a.content;
  else if (typeof a.patch === "string") {
    body = a.patch
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1))
      .join("\n");
  }
  const all = body.split("\n");
  const max = 12;
  return {
    path: basename(path) || path,
    plus: all.length,
    lines: all.slice(0, max),
    hidden: Math.max(0, all.length - max),
  };
}

export function userBanner(text: string, images = 0, cols = 80): string {
  const width = Math.max(40, Math.min(cols, 120));
  const extra = images ? `\n[${images} image${images === 1 ? "" : "s"}]` : "";
  const body = (text.trim() || "(empty)") + extra;
  return wrapWords(body, width - 2)
    .map((l) => {
      const pad = ` ${l.padEnd(width - 1)}`;
      return process.env.NO_COLOR ? pad : `\x1b[48;5;236m\x1b[37m${pad}\x1b[0m`;
    })
    .join("\n");
}

export function wrapWords(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!para) {
      out.push("");
      continue;
    }
    let line = "";
    for (const w of para.split(/(\s+)/)) {
      if ((line + w).length > width && line.trim()) {
        out.push(line.trimEnd());
        line = w.trimStart();
      } else line += w;
    }
    out.push(line.trimEnd());
  }
  return out.length ? out : [""];
}
