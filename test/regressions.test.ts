/**
 * Named regressions: each test is a behavior we already got wrong once
 * (or will, if it drifts). Keep the assertion literal.
 */
import { describe, expect, test } from "bun:test";
import { classifyBash, Policy } from "../src/policy/policy.ts";
import { loadConfig } from "../src/config.ts";
import { resolveInWorkspace } from "../src/tools/paths.ts";
import { validate } from "../src/tools/schema.ts";
import { wantsContract } from "../src/agent/contract.ts";
import { howBeforeMutate, noteObservation, stateKnowsPath } from "../src/agent/gates.ts";
import { StateStore } from "../src/state/store.ts";
import { tmpProject, bootFake } from "./helpers.ts";
import { fakeTurn, fc, assistant, FakeClient } from "../src/provider/fake.ts";
import { run } from "../src/agent/loop.ts";
import { ALL_TOOLS, ToolGateway } from "../src/tools/index.ts";
import { Trace } from "../src/state/trace.ts";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { isMessage, textOf } from "../src/provider/types.ts";

describe("regressions", () => {
  test("R1 update_state serializes even though risk is read", () => {
    const cwd = tmpProject();
    const cfg = loadConfig(cwd, { sandbox: false });
    const gw = new ToolGateway(
      ALL_TOOLS,
      new Policy(cfg, "edit", false),
      new Trace(join(cwd, "t.jsonl")),
      cfg,
      async () => ({ kind: "reject" }),
    );
    expect(
      gw.isParallelSafe({
        type: "function_call",
        call_id: "1",
        name: "update_state",
        arguments: '{"facts":["a"]}',
      }),
    ).toBe(false);
    expect(
      gw.isParallelSafe({
        type: "function_call",
        call_id: "2",
        name: "update_plan",
        arguments: '{"steps":[]}',
      }),
    ).toBe(false);
  });

  test("R2 awk inplace is not read-only", () => {
    expect(classifyBash("awk -i inplace '{print}' x").risk).not.toBe("read");
  });

  test("R3 gh api is fail-closed", () => {
    expect(classifyBash("gh api repos/o/r -f body=x").risk).toBe("external");
  });

  test("R4 opaque $(...) cannot auto-run as read in edit", () => {
    const c = classifyBash("echo $(wget -qO- http://x)");
    expect(c.opaque).toBe(true);
    const p = new Policy(loadConfig(process.cwd(), { mode: "edit" }), "edit", true);
    expect(p.decide("bash", c.risk).action).toBe("ask");
  });

  test("R5 .git paths are refused", () => {
    expect("error" in resolveInWorkspace("/ws", ".git/hooks/pre-commit")).toBe(true);
  });

  test("R6 null does not satisfy string schema", () => {
    const problems = validate(
      { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      { path: null },
    );
    expect(problems.join(" ")).toMatch(/null/);
  });

  test("R7 chat auto skips contract, run auto wants one", () => {
    expect(wantsContract("auto", true)).toBe(false);
    expect(wantsContract("auto", false)).toBe(true);
    expect(wantsContract("never", false)).toBe(false);
  });

  test("R8 how-before-mutate names the file", () => {
    const dir = tmpProject();
    const state = new StateStore(dir, "s");
    const msg = howBeforeMutate(
      {
        type: "function_call",
        call_id: "1",
        name: "write",
        arguments: JSON.stringify({ path: "src/hello.ts", content: "x" }),
      },
      new Set(),
      state,
    );
    expect(msg).toMatch(/src\/hello\.ts/);
  });

  test("R8b ls does not unlock src/hello.ts", () => {
    const dir = tmpProject();
    const state = new StateStore(dir, "s");
    const observed = new Set<string>();
    noteObservation(
      observed,
      { type: "function_call", call_id: "1", name: "ls", arguments: "{}" },
      true,
    );
    noteObservation(
      observed,
      {
        type: "function_call",
        call_id: "2",
        name: "ls",
        arguments: JSON.stringify({ path: "." }),
      },
      true,
    );
    const msg = howBeforeMutate(
      {
        type: "function_call",
        call_id: "3",
        name: "write",
        arguments: JSON.stringify({ path: "src/hello.ts", content: "x" }),
      },
      observed,
      state,
    );
    expect(msg).toMatch(/src\/hello\.ts/);
    state.update({ facts: ["the source lives under src/"] });
    expect(stateKnowsPath(state, "src/hello.ts")).toBe(false);
    state.update({ facts: ["see src/hello.ts"] });
    expect(stateKnowsPath(state, "src/hello.ts")).toBe(true);
  });

  test("R9 incomplete streams must not be billed as $0 success (no ZERO_USAGE fallback in xai)", async () => {
    const src = await Bun.file(new URL("../src/provider/xai.ts", import.meta.url)).text();
    expect(src).not.toMatch(/ZERO_USAGE/);
    expect(src).toMatch(/stream ended without a response\.completed event/);
  });

  test("R10 noninteractive curl is denied and traced", async () => {
    const dir = tmpProject();
    const rt = await bootFake(dir, [
      fakeTurn([fc("bash", { command: "curl https://example.com" })]),
      fakeTurn([assistant("stopped")]),
    ]);
    await run(rt, "curl");
    expect(rt.trace.filter("policy.blocked").length).toBeGreaterThan(0);
  });

  test("R12 receipt lists files from tool.changed, not just evidence", async () => {
    const dir = tmpProject();
    const rt = await bootFake(dir, [
      fakeTurn([fc("read", { path: "src/hello.ts" }, "r1")]),
      fakeTurn([fc("write", { path: "src/hello.ts", content: "export const n = 9;\n" }, "w1")]),
      fakeTurn([assistant("ok")]),
    ]);
    const result = await run(rt, "set n=9");
    expect(result.receipt).toContain("src/hello.ts");
    expect(
      rt.trace.filter("tool.result").some((e) => (e.changed ?? []).includes("src/hello.ts")),
    ).toBe(true);
  });

  test("R13 first turn has no status ping; only role=user is the human", async () => {
    const dir = tmpProject();
    const rt = await bootFake(dir, [fakeTurn([assistant("ok")])]);
    await run(rt, "hi");
    const calls = (rt.client as FakeClient).calls;
    expect(calls.length).toBeGreaterThan(0);
    const first = calls[0]!;
    expect(first.instructions).toMatch(/Only a role=user message is the human/);
    expect(first.instructions).not.toMatch(/The user may interrupt/);
    const reminders = first.input.filter(isMessage).filter((m) => m.meta?.kind === "reminder");
    expect(reminders).toHaveLength(0);
    const users = first.input.filter(isMessage).filter((m) => m.role === "user");
    expect(users.some((m) => /HARNESS STATUS/.test(String(m.content)))).toBe(false);
    expect(first.input.some((m) => isMessage(m) && /HARNESS STATUS/.test(String(m.content)))).toBe(
      false,
    );
  });

  test("R11 oxfmt and oxlint are wired into check", async () => {
    const pkg = JSON.parse(await Bun.file(new URL("../package.json", import.meta.url)).text()) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies.oxlint).toBeTruthy();
    expect(pkg.devDependencies.oxfmt).toBeTruthy();
    expect(pkg.scripts.lint).toMatch(/oxlint/);
    expect(pkg.scripts.format).toMatch(/oxfmt/);
    expect(pkg.scripts.check).toMatch(/lint/);
  });

  test("R14 instructions stay frozen after mutate; approxTokens counts projected history", async () => {
    const dir = tmpProject();
    Bun.spawnSync(["git", "init"], { cwd: dir, stderr: "pipe" });
    const rt = await bootFake(dir, [
      fakeTurn([fc("read", { path: "src/hello.ts" }, "r1")]),
      fakeTurn([fc("write", { path: "src/hello.ts", content: "export const n = 2;\n" }, "w1")]),
      fakeTurn([assistant("updated")]),
    ]);
    await run(rt, "set n=2");
    const calls = (rt.client as FakeClient).calls;
    const instrs = calls.map((c) => c.instructions);
    expect(instrs.length).toBeGreaterThan(1);
    expect(new Set(instrs).size).toBe(1);
    expect(instrs[0]).not.toMatch(/modified file\(s\)/);
    const last = calls.at(-1)!;
    const reminder = last.input.filter(isMessage).find((m) => m.meta?.kind === "reminder");
    expect(reminder).toBeTruthy();
    expect(textOf(reminder!)).toMatch(/modified file\(s\)/);
    const naive = Math.ceil((last.instructions!.length + textOf(reminder!).length) / 4);
    const logged = rt.trace.filter("model.request").at(-1)!.approxTokens ?? 0;
    expect(logged).toBeGreaterThan(naive);
  });

  test("R15 bash-only writes snapshot via dirty() and trip verify on run", async () => {
    const dir = tmpProject();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "toy" }));
    const rt = await bootFake(
      dir,
      [
        fakeTurn([
          fc("bash", {
            command: `bun -e 'await Bun.write("src/hello.ts","export const n = 2\\n")'`,
          }),
        ]),
        fakeTurn([assistant("done")]),
        fakeTurn([assistant('{"verdict":"pass","findings":[]}')]),
      ],
      {},
      { kind: "run" },
    );
    await run(rt, "set n=2 via bash");
    expect(rt.session.meta.checkpoints.some((c) => c.turn >= 1)).toBe(true);
    expect(rt.trace.filter("verify.verdict").length).toBeGreaterThan(0);
  });

  test("R16 chat remembers observation across turns", async () => {
    const dir = tmpProject();
    const rt = await bootFake(
      dir,
      [
        fakeTurn([fc("read", { path: "src/hello.ts" }, "r1")]),
        fakeTurn([assistant("saw it")]),
        fakeTurn([fc("write", { path: "src/hello.ts", content: "export const n = 4;\n" }, "w1")]),
        fakeTurn([assistant("wrote")]),
      ],
      {},
      { interactive: true, kind: "chat" },
    );
    await run(rt, "look");
    expect(rt.session.meta.observed ?? []).toContain("src/hello.ts");
    await run(rt, "change n");
    expect(await Bun.file(join(dir, "src/hello.ts")).text()).toContain("n = 4");
    expect(
      rt.trace
        .filter("policy.blocked")
        .every((e) => !String(e.reason ?? "").includes("how-before-mutate")),
    ).toBe(true);
  });

  test("R17 two boots in one repo fail with session in use", async () => {
    const dir = tmpProject();
    await bootFake(dir, [fakeTurn([assistant("a")])]);
    await expect(bootFake(dir, [fakeTurn([assistant("b")])])).rejects.toThrow(/session in use/);
  });

  test("R18 pre-tool output_text is not mixed into reasoning", async () => {
    const dir = tmpProject();
    const thoughts: string[] = [];
    const texts: string[] = [];
    const rt = await bootFake(
      dir,
      [
        fakeTurn([assistant("I'll start by reading"), fc("read", { path: "src/hello.ts" }, "r1")]),
        fakeTurn([assistant("n is 1")]),
      ],
      {},
      {
        ui: {
          text: (s) => texts.push(s),
          reasoning: (s) => thoughts.push(s),
          tool() {},
          note() {},
        },
      },
    );
    await run(rt, "what is n");
    expect(thoughts.join("")).not.toMatch(/I'll start by reading/);
    expect(texts.join("")).toMatch(/n is 1/);
  });
});
