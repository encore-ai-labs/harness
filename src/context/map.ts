/**
 * Project map: a small, always-loaded picture of the environment.
 *
 * "Give the agent a map, not a manual." We never dump the repo into context.
 * The map tells the model where things are, what commands exist, which skills
 * are installed, and what the humans wrote in their instruction files. Skill
 * bodies are not dumped here — the skill tool loads SKILL.md on demand.
 *
 * Bounded by construction: the tree is depth-limited and entry-limited, and
 * instruction files are capped, so the map's token cost is predictable.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { platform, release } from "node:os";

import { discoverSkills, renderSkillCatalog, type Skill } from "../skills/discover.ts";

export interface ProjectMap {
  cwd: string;
  platform: string;
  git: { branch: string; dirty: number; recent: string[] } | null;
  tree: string;
  stack: { kind: string; details: string[] };
  commands: Record<string, string>;
  instructions: Array<{ path: string; content: string }>;
  skills: Skill[];
  sources: string[];
  chars: number;
}

const IGNORE = new Set([
  "node_modules",
  ".git",
  ".harness",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".DS_Store",
  "target",
  ".cache",
  ".idea",
  ".vscode",
  "vendor",
  ".expo",
  "Pods",
]);

async function run(cmd: string[], cwd: string): Promise<string> {
  try {
    const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    return code === 0 ? out.trim() : "";
  } catch {
    return "";
  }
}

function tree(root: string, maxDepth = 3, maxEntries = 200): string {
  const lines: string[] = [];
  let count = 0;
  const walk = (dir: string, depth: number, prefix: string) => {
    if (depth > maxDepth || count >= maxEntries) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).filter(
        (e) => !IGNORE.has(e) && (!e.startsWith(".") || e === ".github"),
      );
    } catch {
      return;
    }
    entries.sort((a, b) => a.localeCompare(b));
    const isDirectory = (e: string) => {
      try {
        return statSync(join(dir, e)).isDirectory();
      } catch {
        return false;
      }
    };
    const dirs = entries.filter(isDirectory);
    const files = entries.filter((e) => !dirs.includes(e));
    for (const e of [...dirs, ...files]) {
      if (count++ >= maxEntries) {
        lines.push(prefix + "…");
        return;
      }
      const isDir = dirs.includes(e);
      lines.push(prefix + e + (isDir ? "/" : ""));
      if (isDir) walk(join(dir, e), depth + 1, prefix + "  ");
    }
  };
  walk(root, 1, "");
  return lines.join("\n");
}

function detectStack(cwd: string): {
  kind: string;
  details: string[];
  commands: Record<string, string>;
} {
  const details: string[] = [];
  const commands: Record<string, string> = {};
  const has = (f: string) => existsSync(join(cwd, f));

  if (has("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
      const pm =
        has("bun.lockb") || has("bun.lock") || typeof process.versions.bun === "string"
          ? "bun"
          : has("pnpm-lock.yaml")
            ? "pnpm"
            : has("yarn.lock")
              ? "yarn"
              : "npm";
      details.push(`node project (${pm})${pkg.name ? `: ${pkg.name}` : ""}`);
      const runner = pm === "npm" ? "npm run" : pm + " run";
      for (const [k, v] of Object.entries(pkg.scripts ?? {})) {
        if (["test", "typecheck", "lint", "build", "check", "format"].includes(k))
          commands[k] = `${runner} ${k}   # ${v}`;
      }
      if (has("tsconfig.json")) {
        details.push("typescript");
        commands.typecheck ??= `${pm === "npm" ? "npx" : pm + "x"} tsc --noEmit`;
      }
    } catch {
      details.push("node project (unreadable package.json)");
    }
  }
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
    details.push(
      "python project" + (has("uv.lock") ? " (uv)" : has("poetry.lock") ? " (poetry)" : ""),
    );
    if (has("pytest.ini") || has("tests") || has("test"))
      commands.test ??= has("uv.lock") ? "uv run pytest" : "pytest";
  }
  if (has("Cargo.toml")) {
    details.push("rust (cargo)");
    commands.test ??= "cargo test";
    commands.build ??= "cargo build";
    commands.check ??= "cargo check";
  }
  if (has("go.mod")) {
    details.push("go");
    commands.test ??= "go test ./...";
    commands.build ??= "go build ./...";
  }
  if (has("Makefile")) {
    details.push("Makefile present");
    try {
      const mk = readFileSync(join(cwd, "Makefile"), "utf8");
      for (const t of ["test", "lint", "build", "check"])
        if (new RegExp(`^${t}:`, "m").test(mk)) commands[t] ??= `make ${t}`;
    } catch {
      /* ignore */
    }
  }
  try {
    if (
      has("Package.swift") ||
      readdirSync(cwd).some((f) => f.endsWith(".xcodeproj") || f.endsWith(".xcworkspace"))
    )
      details.push("swift / xcode");
  } catch {
    /* ignore */
  }
  if (has("app.json") && has("package.json")) details.push("possibly expo / react native");

  return { kind: details[0] ?? "unknown", details, commands };
}

/** Find instruction files in cwd and its parents (nearest wins on name clash), capped in size. */
function findInstructions(
  cwd: string,
  names: string[],
  maxChars = 12_000,
): Array<{ path: string; content: string }> {
  const found: Array<{ path: string; content: string }> = [];
  const seen = new Set<string>();
  let dir = cwd;
  for (let i = 0; i < 6; i++) {
    for (const n of names) {
      const p = join(dir, n);
      if (seen.has(basename(n)) || !existsSync(p)) continue;
      try {
        let content = readFileSync(p, "utf8");
        if (content.length > maxChars)
          content =
            content.slice(0, maxChars) + `\n…[truncated ${content.length - maxChars} chars]`;
        found.push({ path: relative(cwd, p) || n, content });
        seen.add(basename(n));
      } catch {
        /* ignore */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

export async function buildProjectMap(
  cwd: string,
  instructionFiles: string[],
): Promise<ProjectMap> {
  const sources: string[] = ["tree", "stack"];
  let git: ProjectMap["git"] = null;
  if (await run(["git", "rev-parse", "--is-inside-work-tree"], cwd)) {
    const branch = await run(["git", "branch", "--show-current"], cwd);
    const status = await run(["git", "status", "--porcelain"], cwd);
    const log = await run(["git", "log", "--oneline", "-n", "5"], cwd);
    git = {
      branch: branch || "(detached)",
      dirty: status ? status.split("\n").length : 0,
      recent: log ? log.split("\n") : [],
    };
    sources.push("git");
  }
  const stack = detectStack(cwd);
  const instructions = findInstructions(cwd, instructionFiles);
  const skills = discoverSkills(cwd);
  for (const i of instructions) sources.push(i.path);
  if (skills.length) sources.push("skills");
  const map: ProjectMap = {
    cwd,
    platform: `${platform()} ${release()}`,
    git,
    tree: tree(cwd),
    stack: { kind: stack.kind, details: stack.details },
    commands: stack.commands,
    instructions,
    skills,
    sources,
    chars: 0,
  };
  map.chars = renderProjectMap(map).length;
  return map;
}

export function renderProjectMap(m: ProjectMap): string {
  const parts: string[] = [];
  parts.push(`cwd: ${m.cwd}\nplatform: ${m.platform}`);
  if (m.git)
    parts.push(
      `git: branch ${m.git.branch}, ${m.git.dirty} modified file(s)\nrecent commits:\n${m.git.recent.map((l) => "  " + l).join("\n")}`,
    );
  parts.push(`stack: ${m.stack.details.join(", ") || "unknown"}`);
  const cmds = Object.entries(m.commands);
  if (cmds.length)
    parts.push(
      `known commands (use these instead of guessing):\n${cmds.map(([k, v]) => `  ${k}: ${v}`).join("\n")}`,
    );
  parts.push(renderSkillCatalog(m.skills));
  parts.push(`tree (depth-limited; use ls/glob for more):\n${m.tree}`);
  return parts.join("\n\n");
}
