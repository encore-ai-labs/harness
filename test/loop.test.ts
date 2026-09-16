import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bootFake, tmpProject } from "./helpers.ts";
import { run } from "../src/agent/loop.ts";
import { fakeTurn, fc, assistant } from "../src/provider/fake.ts";
import { Session } from "../src/state/session.ts";
import { userMessage } from "../src/provider/types.ts";
import { renderReceipt } from "../src/agent/receipt.ts";
import { ALL_TOOLS, ToolGateway } from "../src/tools/index.ts";
import { Policy } from "../src/policy/policy.ts";
import { loadConfig } from "../src/config.ts";
import { Trace } from "../src/state/trace.ts";

describe("loop", () => {
  test("read then write then stop", async () => {
    const dir = tmpProject();
    const rt = await bootFake(dir, [
      fakeTurn([fc("read", { path: "src/hello.ts" }, "c1")]),
      fakeTurn([fc("write", { path: "src/hello.ts", content: "export const n = 2;\n" }, "c2")]),
      fakeTurn([assistant("updated hello.ts")]),
    ]);
    const result = await run(rt, "change n to 2");
    expect(result.status).toBe("completed");
    expect(await Bun.file(join(dir, "src/hello.ts")).text()).toContain("n = 2");
    expect(result.text).toMatch(/updated/);
    expect(result.receipt).toContain("src/hello.ts");
  });

  test("how-before-mutate denies write without read", async () => {
    const dir = tmpProject();
    const rt = await bootFake(dir, [
      fakeTurn([fc("write", { path: "src/hello.ts", content: "nope" }, "w1")]),
      fakeTurn([assistant("ok I will read first")]),
    ]);
    await run(rt, "edit hello");
    const blocked = rt.trace.filter("policy.blocked");
    expect(blocked.some((e) => e.reason.includes("how-before-mutate"))).toBe(true);
    expect(await Bun.file(join(dir, "src/hello.ts")).text()).toContain("n = 1");
  });

  test("plan-before-write on run", async () => {
    const dir = tmpProject();
    const rt = await bootFake(
      dir,
      [
        fakeTurn([fc("read", { path: "src/hello.ts" }, "r1")]),
        fakeTurn([fc("write", { path: "src/hello.ts", content: "x" }, "w1")]),
        fakeTurn([assistant("done")]),
      ],
      {},
      { kind: "run", interactive: false },
    );
    await run(rt, "change it");
    expect(
      rt.trace.filter("policy.blocked").some((e) => e.reason.includes("plan-before-write")),
    ).toBe(true);
  });

  test("mixed batch: read then write in one response", async () => {
    const dir = tmpProject();
    const rt = await bootFake(dir, [
      fakeTurn([
        fc("read", { path: "src/hello.ts" }, "r1"),
        fc("write", { path: "src/hello.ts", content: "export const n = 3;\n" }, "w1"),
      ]),
      fakeTurn([assistant("done")]),
    ]);
    await run(rt, "set n=3");
    expect(await Bun.file(join(dir, "src/hello.ts")).text()).toContain("n = 3");
  });

  test("budget stop", async () => {
    const dir = tmpProject();
    const rt = await bootFake(
      dir,
      [
        fakeTurn([fc("read", { path: "src/hello.ts" }, "r1")]),
        fakeTurn([fc("read", { path: "src/hello.ts" }, "r2")]),
        fakeTurn([assistant("more")]),
      ],
      { maxTurns: 1 },
    );
    const result = await run(rt, "look around");
    expect(result.status).toBe("escalated");
    expect(rt.trace.filter("budget.exceeded").length).toBeGreaterThan(0);
  });

  test("noninteractive deny lands in receipt", async () => {
    const dir = tmpProject();
    const rt = await bootFake(dir, [
      fakeTurn([fc("bash", { command: "curl https://example.com" }, "b1")]),
      fakeTurn([assistant("cannot")]),
    ]);
    await run(rt, "hit the network");
    const receipt = renderReceipt(rt.session, rt.trace);
    expect(receipt).toMatch(/APPROVAL NEEDED|blocked/i);
    expect(rt.trace.filter("policy.blocked").length).toBeGreaterThan(0);
  });

  test("resume seals orphan tool calls", async () => {
    const dir = tmpProject();
    const s = Session.create(dir, "grok-4.6", "edit");
    s.append(userMessage("hi", { turn: 1 }));
    s.append({
      type: "function_call",
      call_id: "orphan",
      name: "read",
      arguments: '{"path":"src/hello.ts"}',
      meta: { turn: 1 },
    });
    s.meta.turns = 1;
    s.saveMeta();
    const rt = await bootFake(dir, [fakeTurn([assistant("resumed")])], {}, { sessionId: s.id });
    expect(
      rt.session.messages.some((i) => i.type === "function_call_output" && i.call_id === "orphan"),
    ).toBe(true);
    const result = await run(rt, "continue");
    expect(result.status).toBe("completed");
  });
});

describe("receipt", () => {
  test("claims are subset of the trace", async () => {
    const dir = tmpProject();
    const rt = await bootFake(dir, [
      fakeTurn([fc("read", { path: "src/hello.ts" }, "r1")]),
      fakeTurn([assistant("it's 1")]),
    ]);
    await run(rt, "what is n?");
    const receipt = renderReceipt(rt.session, rt.trace);
    const names = rt.trace.filter("tool.result").map((e) => e.name);
    for (const n of names) expect(receipt.includes(n) || n === "read").toBe(true);
    expect(receipt).toContain(rt.session.id);
    expect(existsSync(join(rt.session.dir, "receipt.md"))).toBe(true);
  });
});

describe("gateway access vs risk", () => {
  test("update_state is not parallel-safe", () => {
    const cwd = tmpProject();
    const gw = new ToolGateway(
      ALL_TOOLS,
      new Policy(loadConfig(cwd, { sandbox: false }), "edit", false),
      new Trace(join(cwd, ".harness", "t.jsonl")),
      loadConfig(cwd),
      async () => ({ kind: "reject" }),
    );
    expect(
      gw.isParallelSafe({
        type: "function_call",
        call_id: "1",
        name: "update_state",
        arguments: '{"facts":["x"]}',
      }),
    ).toBe(false);
    expect(
      gw.isParallelSafe({
        type: "function_call",
        call_id: "2",
        name: "read",
        arguments: '{"path":"src/hello.ts"}',
      }),
    ).toBe(true);
  });
});
