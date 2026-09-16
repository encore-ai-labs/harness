/**
 * Agent Skills (SKILL.md) discovery. Catalog only — bodies are loaded on demand
 * via the skill tool so the prefix cache stays small.
 *
 * Search order (later wins on name clash: project beats user beats shared):
 *   ~/.claude/skills, ~/.agents/skills, ~/.cursor/skills, ~/.harness/skills
 *   <cwd>/skills, <cwd>/.agents/skills, <cwd>/.cursor/skills, <cwd>/.harness/skills
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export interface Skill {
  name: string;
  description: string;
  dir: string;
  skillMd: string;
  scope: "user" | "project";
}

export function skillRoots(cwd: string): Array<{ dir: string; scope: Skill["scope"] }> {
  const home = homedir();
  return [
    { dir: join(home, ".claude", "skills"), scope: "user" },
    { dir: join(home, ".agents", "skills"), scope: "user" },
    { dir: join(home, ".cursor", "skills"), scope: "user" },
    { dir: join(home, ".harness", "skills"), scope: "user" },
    { dir: join(cwd, "skills"), scope: "project" },
    { dir: join(cwd, ".agents", "skills"), scope: "project" },
    { dir: join(cwd, ".cursor", "skills"), scope: "project" },
    { dir: join(cwd, ".harness", "skills"), scope: "project" },
  ];
}

export function discoverSkills(cwd: string): Skill[] {
  const byName = new Map<string, Skill>();
  for (const root of skillRoots(cwd)) {
    if (!existsSync(root.dir) || !statSync(root.dir).isDirectory()) continue;
    for (const skill of skillsInTree(root.dir, root.scope, 3)) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findSkill(cwd: string, name: string): Skill | undefined {
  const n = name.trim().toLowerCase();
  return discoverSkills(cwd).find((s) => s.name.toLowerCase() === n);
}

/** Walk a directory for SKILL.md. Also accepts a folder that is itself a skill. */
export function skillsInTree(root: string, scope: Skill["scope"], maxDepth: number): Skill[] {
  const out: Skill[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth < 0 || !existsSync(dir)) return;
    const md = join(dir, "SKILL.md");
    if (existsSync(md) && statSync(md).isFile()) {
      const parsed = parseSkillMd(readFileSync(md, "utf8"), dir);
      out.push({ ...parsed, dir: resolve(dir), skillMd: resolve(md), scope });
      return;
    }
    if (depth === 0) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.startsWith(".") && e !== ".agents" && e !== ".cursor" && e !== ".harness") continue;
      const p = join(dir, e);
      try {
        if (statSync(p).isDirectory()) walk(p, depth - 1);
      } catch {
        /* ignore */
      }
    }
  };
  walk(root, maxDepth);
  return out;
}

export function parseSkillMd(
  raw: string,
  fallbackDir: string,
): { name: string; description: string } {
  let name = basename(fallbackDir);
  let description = "";
  const fm = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (fm) {
    const block = fm[1] ?? "";
    const nm = /^name:\s*(.+)$/m.exec(block);
    const ds = /^description:\s*(.+)$/m.exec(block);
    if (nm) name = stripQuotes(nm[1]!.trim());
    if (ds) description = stripQuotes(ds[1]!.trim());
  }
  if (!description) {
    const line = raw
      .replace(/^---[\s\S]*?---/, "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"));
    description = (line ?? "").slice(0, 240);
  }
  return { name, description };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
    return s.slice(1, -1);
  return s;
}

export function renderSkillCatalog(skills: Skill[]): string {
  if (!skills.length)
    return "skills: none. Install with `harness skill add <github-or-path>` (e.g. EvanBacon/serve-sim).";
  return (
    "skills (load with the skill tool before using; do not guess the CLI):\n" +
    skills.map((s) => `  ${s.name}  [${s.scope}]  ${s.description}`).join("\n")
  );
}
