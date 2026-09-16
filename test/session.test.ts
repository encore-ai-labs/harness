import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/state/session.ts";
import { Trace } from "../src/state/trace.ts";
import { Checkpoints } from "../src/state/checkpoint.ts";
import { userMessage } from "../src/provider/types.ts";
import {
  project,
  EMPTY_CURSOR,
  advancePrune,
  sealDanglingCalls,
  truncateToTurn,
} from "../src/agent/context.ts";
import { DEFAULTS } from "../src/config.ts";

function dir() {
  return mkdtempSync(join(tmpdir(), "harness-sess-"));
}

describe("Session", () => {
  test("append and load", () => {
    const cwd = dir();
    const s = Session.create(cwd, "grok-4.6", "edit");
    s.append(userMessage("hello", { turn: 1 }));
    const id = s.id;
    const loaded = Session.load(cwd, id);
    expect(loaded.messages.length).toBe(1);
    expect(loaded.meta.title).toMatch(/hello/);
  });
  test("list newest first", () => {
    const cwd = dir();
    Session.create(cwd, "m", "edit");
    Session.create(cwd, "m", "edit");
    expect(Session.list(cwd).length).toBe(2);
  });
});

describe("Trace", () => {
  test("hydrate and stop on malformed", () => {
    const cwd = dir();
    mkdirSync(join(cwd, ".harness"), { recursive: true });
    const p = join(cwd, ".harness", "t.jsonl");
    writeFileSync(p, `{"ev":"note","text":"a","t":"t"}\nNOT JSON\n{"ev":"note","text":"b"}\n`);
    const t = Trace.load(p);
    expect(t.all().length).toBe(1);
    t.log({ ev: "note", text: "c" });
    expect(t.filter("note").length).toBe(2);
  });
});

describe("Checkpoints", () => {
  test("snapshot and rewind", async () => {
    const cwd = dir();
    writeFileSync(join(cwd, "a.txt"), "one");
    const cp = new Checkpoints(cwd);
    const s1 = await cp.snapshot("start");
    expect(s1).not.toBeNull();
    writeFileSync(join(cwd, "a.txt"), "two");
    const s2 = await cp.snapshot("edit");
    expect(s2).not.toBeNull();
    await cp.rewind(s1!.sha);
    expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("one");
  });
});

describe("ContextCursor", () => {
  test("project prunes old tool output", () => {
    const items = [
      userMessage("hi", { turn: 1 }),
      {
        type: "function_call_output" as const,
        call_id: "1",
        output: "x".repeat(100),
        meta: { turn: 1 },
      },
      userMessage("later", { turn: 20 }),
    ];
    const cursor = { ...EMPTY_CURSOR, prunedThroughTurn: 1 };
    const p = project(items, cursor);
    const out = p.find((i) => i.type === "function_call_output") as { output: string };
    expect(out.output).toMatch(/pruned/);
  });
  test("seal dangling calls", () => {
    const items = [{ type: "function_call" as const, call_id: "x", name: "read", arguments: "{}" }];
    const sealed = sealDanglingCalls(items);
    expect(sealed.length).toBe(2);
    expect(sealed[1]).toMatchObject({ type: "function_call_output", call_id: "x" });
  });
  test("truncateToTurn keeps pairs", () => {
    const items = [
      userMessage("a", { turn: 1 }),
      {
        type: "function_call" as const,
        call_id: "x",
        name: "read",
        arguments: "{}",
        meta: { turn: 2 },
      },
      { type: "function_call_output" as const, call_id: "x", output: "ok", meta: { turn: 2 } },
      userMessage("b", { turn: 3 }),
    ];
    expect(
      truncateToTurn(items, 2).some(
        (i) =>
          i.type === "message" &&
          "role" in i &&
          i.role === "user" &&
          JSON.stringify(i).includes("b"),
      ),
    ).toBe(false);
  });
  test("advancePrune waits for min chars", () => {
    const items = [
      { type: "function_call_output" as const, call_id: "1", output: "tiny", meta: { turn: 1 } },
    ];
    const c = advancePrune(items, EMPTY_CURSOR, 20, DEFAULTS.context);
    expect(c.prunedThroughTurn).toBe(-1);
  });
});
