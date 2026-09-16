/**
 * Install Agent Skills into ~/.harness/skills (user) or <cwd>/.harness/skills (project).
 *
 *   harness skill add EvanBacon/serve-sim
 *   harness skill add https://github.com/EvanBacon/serve-sim
 *   harness skill add ./path/to/skill
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { skillsInTree, type Skill } from "./discover.ts";

export async function installSkill(
  source: string,
  opts: { cwd: string; project?: boolean; force?: boolean },
): Promise<Skill[]> {
  const destRoot = opts.project
    ? join(opts.cwd, ".harness", "skills")
    : join(homedir(), ".harness", "skills");
  mkdirSync(destRoot, { recursive: true });

  const local = resolve(opts.cwd, source);
  if (existsSync(local)) {
    const found = skillsInTree(local, opts.project ? "project" : "user", 4);
    if (!found.length) throw new Error(`${source} has no SKILL.md`);
    return found.map((s) =>
      copySkill(s.dir, destRoot, s.name, opts.force, opts.project ? "project" : "user"),
    );
  }

  const repo = parseGithub(source);
  if (!repo)
    throw new Error(`don't know how to install ${source}; pass owner/repo or a local path`);
  const tmp = mkdtempSync(join(tmpdir(), "harness-skill-"));
  try {
    const url = `https://github.com/${repo.owner}/${repo.repo}.git`;
    const r = Bun.spawn(["git", "clone", "--depth", "1", url, tmp], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(r.stderr).text();
    const code = await r.exited;
    if (code !== 0) throw new Error(`git clone failed: ${err.trim() || code}`);
    const found = skillsInTree(tmp, opts.project ? "project" : "user", 5);
    if (!found.length) throw new Error(`${url} has no SKILL.md`);
    const want = repo.subpath ? found.filter((s) => s.dir.includes(repo.subpath!)) : found;
    const pick = want.length ? want : found;
    return pick.map((s) =>
      copySkill(s.dir, destRoot, s.name, opts.force, opts.project ? "project" : "user"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function removeSkill(name: string, opts: { cwd: string; project?: boolean }): string {
  const destRoot = opts.project
    ? join(opts.cwd, ".harness", "skills")
    : join(homedir(), ".harness", "skills");
  const dir = join(destRoot, name);
  if (!existsSync(dir)) throw new Error(`no installed skill ${name} in ${destRoot}`);
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

function copySkill(
  from: string,
  destRoot: string,
  name: string,
  force: boolean | undefined,
  scope: Skill["scope"],
): Skill {
  const dest = join(destRoot, name);
  if (existsSync(dest) && !force) throw new Error(`${dest} exists; pass --force to overwrite`);
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  cpSync(from, dest, { recursive: true });
  const found = skillsInTree(dest, scope, 1);
  const s = found[0];
  if (!s) throw new Error(`copied ${from} but no SKILL.md at ${dest}`);
  return s;
}

function parseGithub(source: string): { owner: string; repo: string; subpath?: string } | null {
  const trimmed = source.trim().replace(/\.git$/, "");
  const url = /github\.com[:/]([^/]+)\/([^/#?]+)(?:\/(?:tree|blob)\/[^/]+\/(.+))?/.exec(trimmed);
  if (url) return { owner: url[1]!, repo: url[2]!, subpath: url[3] || undefined };
  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(.+))?$/.exec(trimmed);
  if (short) return { owner: short[1]!, repo: short[2]!, subpath: short[3] || undefined };
  return null;
}
