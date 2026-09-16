/**
 * Loop gates. Prompt can say these; this file makes them true.
 */
import { patchPaths } from "../tools/apply_patch.ts";
import type { FunctionCallItem } from "../provider/types.ts";
import type { StateStore } from "../state/store.ts";

const FILE_MUTATORS = new Set(["write", "edit", "apply_patch"]);

export function pathsOfCall(call: FunctionCallItem): string[] {
  try {
    const a = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
    if (call.name === "write" || call.name === "edit" || call.name === "read") {
      return typeof a.path === "string" ? [a.path] : [];
    }
    if (call.name === "grep" || call.name === "glob" || call.name === "ls") {
      return typeof a.path === "string" ? [a.path] : ["."];
    }
    if (call.name === "apply_patch" && typeof a.patch === "string") return patchPaths(a.patch);
  } catch {
    /* ignore */
  }
  return [];
}

export function noteObservation(observed: Set<string>, call: FunctionCallItem, ok: boolean) {
  if (!ok) return;
  if (call.name === "read" || call.name === "grep" || call.name === "glob" || call.name === "ls") {
    for (const p of pathsOfCall(call)) observed.add(norm(p));
  }
}

export function stateKnowsPath(state: StateStore, path: string): boolean {
  const n = norm(path);
  const blob = [
    ...state.get().facts.map((f) => f.text),
    ...state.get().decisions.map((d) => d.text),
  ].join("\n");
  return blob.includes(n) || blob.includes(path);
}

/** Deny the first mutating file tool until the file has been observed. */
export function howBeforeMutate(
  call: FunctionCallItem,
  observed: Set<string>,
  state: StateStore,
): string | null {
  if (!FILE_MUTATORS.has(call.name)) return null;
  const paths = pathsOfCall(call);
  if (!paths.length) return null;
  const missing = paths.filter((p) => !isObserved(observed, p) && !stateKnowsPath(state, p));
  if (!missing.length) return null;
  return `how-before-mutate: read or grep ${missing.join(", ")} before changing ${call.name === "apply_patch" ? "those files" : "it"}`;
}

export function planBeforeWrite(
  call: FunctionCallItem,
  opts: { requirePlan: boolean; hasPlan: boolean },
): string | null {
  if (!opts.requirePlan) return null;
  if (!FILE_MUTATORS.has(call.name) && call.name !== "bash") return null;
  if (call.name === "bash") {
    try {
      const cmd = String(JSON.parse(call.arguments || "{}").command ?? "");
      if (!/\b(rm|mv|cp|mkdir|touch|sed|awk|tee|patch)\b/.test(cmd) && !/[>]/.test(cmd))
        return null;
    } catch {
      return null;
    }
  }
  if (opts.hasPlan) return null;
  return "plan-before-write: call update_plan before the first write on a multi-step task";
}

function isObserved(observed: Set<string>, path: string): boolean {
  const n = norm(path);
  if (observed.has(n) || observed.has(".")) return true;
  for (const o of observed) {
    if (n === o || n.startsWith(o.endsWith("/") ? o : o + "/") || o.startsWith(n + "/"))
      return true;
  }
  return false;
}

function norm(p: string): string {
  return p.replace(/^\.\//, "").replace(/\\/g, "/");
}
