/**
 * Path safety shared by all file tools. Every path the model gives us is
 * resolved against cwd and must stay inside it. This is a precondition, not a
 * prompt instruction: the model cannot talk its way out of the workspace.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

export function resolveInWorkspace(
  cwd: string,
  p: string,
): { abs: string; rel: string } | { error: string } {
  if (typeof p !== "string" || !p.trim()) return { error: "path is required" };
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  const rel = relative(cwd, abs);
  if (rel === "") return { abs, rel: "." };
  if (rel.startsWith("..") || isAbsolute(rel))
    return { error: `path ${p} is outside the workspace (${cwd})` };
  if (rel.split(sep)[0] === ".harness")
    return { error: `path ${p} is inside .harness/, which is harness-owned` };
  if (rel.split(sep).includes(".git"))
    return { error: `path ${p} is inside .git/, which is outside harness control` };
  return { abs, rel };
}
