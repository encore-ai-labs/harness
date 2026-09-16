import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import {
  parseSkillMd,
  discoverSkills,
  findSkill,
  renderSkillCatalog,
} from "../src/skills/discover.ts";
import { installSkill, removeSkill } from "../src/skills/install.ts";
import { skillTool } from "../src/tools/skill.ts";
import { ALL_TOOLS } from "../src/tools/index.ts";
import { loadConfig } from "../src/config.ts";
import { Trace } from "../src/state/trace.ts";
import { StateStore } from "../src/state/store.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { parseArgs } from "../src/cli/args.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "harness-skill-"));
}

function writeSkill(dir: string, name: string, body = "Do the thing with `demo-cli`.") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Demo skill for tests\n---\n\n# ${name}\n\n${body}\n`,
  );
  writeFileSync(join(dir, "notes.md"), "extra ref\n");
}

function ctx(cwd: string): ToolContext {
  return {
    cwd,
    config: loadConfig(cwd, { sandbox: false }),
    trace: new Trace(join(cwd, "t.jsonl")),
    state: new StateStore(cwd, "s"),
    sessionId: "s",
    turn: 1,
    sandboxed: false,
  };
}

describe("skills", () => {
  test("ALL_TOOLS includes skill", () => {
    expect(ALL_TOOLS.some((t) => t.name === "skill")).toBe(true);
  });

  test("parseSkillMd reads frontmatter", () => {
    const p = parseSkillMd(
      "---\nname: serve-sim\ndescription: Drive a simulator\n---\n\n# Hi\n",
      "/x/serve-sim",
    );
    expect(p.name).toBe("serve-sim");
    expect(p.description).toBe("Drive a simulator");
  });

  test("project skill is discovered and beats a same-named user skill", () => {
    const home = tmp();
    const cwd = tmp();
    writeSkill(join(home, ".agents", "skills", "demo"), "demo", "user copy");
    writeSkill(join(cwd, ".harness", "skills", "demo"), "demo", "project copy");
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const skills = discoverSkills(cwd);
      const d = skills.find((s) => s.name === "demo");
      expect(d?.scope).toBe("project");
      expect(d?.dir).toContain(cwd);
    } finally {
      process.env.HOME = prev;
    }
  });

  test("install from a local folder into project skills", async () => {
    const cwd = tmp();
    const src = join(cwd, "incoming");
    writeSkill(src, "toy-skill");
    const installed = await installSkill(src, { cwd, project: true });
    expect(installed[0]?.name).toBe("toy-skill");
    expect(existsSync(join(cwd, ".harness", "skills", "toy-skill", "SKILL.md"))).toBe(true);
    expect(findSkill(cwd, "toy-skill")?.name).toBe("toy-skill");
    const gone = removeSkill("toy-skill", { cwd, project: true });
    expect(gone).toContain("toy-skill");
    expect(findSkill(cwd, "toy-skill")).toBeUndefined();
  });

  test("skill tool lists, reads SKILL.md, and refuses path escape", async () => {
    const cwd = tmp();
    writeSkill(
      join(cwd, ".harness", "skills", "serve-sim"),
      "serve-sim",
      "Use npx @expo/serve-sim.",
    );
    const c = ctx(cwd);
    const listed = await skillTool.execute({}, c);
    expect(listed.ok).toBe(true);
    expect(listed.output).toContain("serve-sim");
    const body = await skillTool.execute({ name: "serve-sim" }, c);
    expect(body.ok).toBe(true);
    expect(body.output).toContain("npx @expo/serve-sim");
    const ref = await skillTool.execute({ name: "serve-sim", file: "notes.md" }, c);
    expect(ref.ok).toBe(true);
    expect(ref.output).toContain("extra ref");
    const escape = await skillTool.execute({ name: "serve-sim", file: "../SKILL.md" }, c);
    expect(escape.ok).toBe(false);
  });

  test("empty catalog tells you how to install", () => {
    expect(renderSkillCatalog([])).toMatch(/harness skill add/);
  });

  test("parseArgs skill add --project --force", () => {
    const a = parseArgs(["skill", "add", "EvanBacon/serve-sim", "--project", "--force"]);
    expect(a.command).toBe("skill");
    expect(a.positional).toEqual(["add", "EvanBacon/serve-sim"]);
    expect(a.flags.project).toBe(true);
    expect(a.flags.force).toBe(true);
    expect(parseArgs(["skills"]).command).toBe("skill");
  });
});
