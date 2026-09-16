import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpProject } from "./helpers.ts";
import { Session } from "../src/state/session.ts";

const bin = join(import.meta.dir, "../src/index.ts");

async function harness(cwd: string, argv: string[]) {
  const proc = Bun.spawn(["bun", bin, ...argv], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, XAI_API_KEY: "", NO_COLOR: "1" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("CLI without API key", () => {
  test("sessions on empty repo", async () => {
    const dir = tmpProject();
    const r = await harness(dir, ["sessions"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/no sessions/);
  });

  test("sessions lists existing", async () => {
    const dir = tmpProject();
    const s = Session.create(dir, "grok-4.6", "edit");
    s.meta.title = "hello world";
    s.saveMeta();
    const r = await harness(dir, ["sessions"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(s.id);
    expect(r.stdout).toContain("hello world");
  });

  test("show prints meta", async () => {
    const dir = tmpProject();
    const s = Session.create(dir, "grok-4.6", "edit");
    const r = await harness(dir, ["show", s.id]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(s.id);
  });

  test("show --receipt", async () => {
    const dir = tmpProject();
    const s = Session.create(dir, "grok-4.6", "edit");
    writeFileSync(join(s.dir, "receipt.md"), "# Receipt\n");
    const r = await harness(dir, ["show", s.id, "--receipt"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("# Receipt");
  });

  test("help", async () => {
    const r = await harness(tmpProject(), ["help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/harness run/);
    expect(r.stdout).toMatch(/harness skill/);
  });

  test("skill add and list from a local folder", async () => {
    const dir = tmpProject();
    const skillDir = join(dir, "incoming-skill");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: toy\ndescription: a toy skill\n---\n\n# toy\n",
    );
    const add = await harness(dir, ["skill", "add", "./incoming-skill", "--project"]);
    expect(add.code).toBe(0);
    expect(add.stdout).toMatch(/installed toy/);
    const list = await harness(dir, ["skill"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("toy");
    const rm = await harness(dir, ["skill", "remove", "toy", "--project"]);
    expect(rm.code).toBe(0);
  });
});
