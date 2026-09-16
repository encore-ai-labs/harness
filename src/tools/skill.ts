/**
 * skill: load an Agent Skill on demand. The catalog lives in the project map;
 * this tool is the only way the model should read SKILL.md and its references.
 * Paths are confined to a discovered skill directory (including ~/.agents).
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { discoverSkills, findSkill } from "../skills/discover.ts";
import { type ToolDefinition, fail, ok } from "./types.ts";

interface Args {
  name?: string;
  file?: string;
}

export const skillTool: ToolDefinition<Args> = {
  name: "skill",
  description:
    "Load an installed Agent Skill. Call with no args to list. Call with name to read SKILL.md. " +
    "Call with name + file to read a file inside the skill (e.g. references/gestures.md). " +
    "Use this before running a skill's CLI (serve-sim, etc.). Do not guess commands from memory.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name (from the catalog)." },
      file: {
        type: "string",
        description: "Optional path relative to the skill directory. Defaults to SKILL.md.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  risk: () => "read",
  access: () => "read",
  summarize: (a) => (a.name ? `${a.name}${a.file ? ` ${a.file}` : ""}` : "list"),
  async execute(a, ctx) {
    if (!a.name) {
      const skills = discoverSkills(ctx.cwd);
      if (!skills.length)
        return ok("no skills installed. User can run: harness skill add EvanBacon/serve-sim", {
          evidence: { count: 0 },
          summary: "none",
        });
      const lines = skills.map((s) => `- ${s.name} [${s.scope}] ${s.description}\n  ${s.dir}`);
      return ok(lines.join("\n"), {
        evidence: { count: skills.length },
        summary: `${skills.length} skills`,
      });
    }
    const skill = findSkill(ctx.cwd, a.name);
    if (!skill) {
      const names = discoverSkills(ctx.cwd)
        .map((s) => s.name)
        .join(", ");
      return fail(`unknown skill "${a.name}". Available: ${names || "(none)"}`, "not_found");
    }
    const rel = (a.file ?? "SKILL.md").replace(/^\/+/, "");
    if (rel.split(sep).includes(".."))
      return fail("file path must stay inside the skill", "invalid_args");
    const abs = resolve(skill.dir, rel);
    if (!inside(skill.dir, abs))
      return fail("file path must stay inside the skill", "invalid_args");
    if (!existsSync(abs)) {
      const listing = listRel(skill.dir).slice(0, 40).join("\n");
      return fail(`${rel} not found. Files:\n${listing}`, "not_found");
    }
    if (statSync(abs).isDirectory()) {
      return ok(
        listRel(abs)
          .map((p) => p)
          .join("\n") || "(empty)",
        { evidence: { dir: rel }, summary: `ls ${rel}` },
      );
    }
    let text = readFileSync(abs, "utf8");
    if (text.length > 40_000) text = text.slice(0, 40_000) + `\n…[truncated]`;
    return ok(text, {
      evidence: { skill: skill.name, file: rel, chars: text.length },
      summary: `${skill.name}/${rel}`,
    });
  },
};

function inside(root: string, abs: string): boolean {
  try {
    const realRoot = realpathSync(root);
    const realAbs = existsSync(abs) ? realpathSync(abs) : abs;
    return realAbs === realRoot || realAbs.startsWith(realRoot + sep);
  } catch {
    return abs === root || abs.startsWith(root + sep);
  }
}

function listRel(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = resolve(d, e);
      const rel = relative(dir, p);
      if (statSync(p).isDirectory()) {
        out.push(rel + "/");
        walk(p);
      } else out.push(rel);
    }
  };
  try {
    walk(dir);
  } catch {
    /* ignore */
  }
  return out;
}
