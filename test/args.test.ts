import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli/args.ts";

describe("parseArgs", () => {
  test("defaults to chat", () => {
    expect(parseArgs([]).command).toBe("chat");
  });
  test("run takes the rest as the task", () => {
    const a = parseArgs(["run", "fix", "the", "bug"]);
    expect(a.command).toBe("run");
    expect(a.positional.join(" ")).toBe("fix the bug");
  });
  test("flags", () => {
    const a = parseArgs([
      "chat",
      "--mode",
      "auto",
      "--no-sandbox",
      "--max-cost=4.5",
      "--effort=medium",
      "--contract=never",
    ]);
    expect(a.flags.mode).toBe("auto");
    expect(a.flags.sandbox).toBe(false);
    expect(a.flags.maxCostUsd).toBe(4.5);
    expect(a.flags.reasoningEffort).toBe("medium");
    expect(a.flags.contract).toBe("never");
  });
  test("show --receipt", () => {
    const a = parseArgs(["show", "abc", "--receipt"]);
    expect(a.command).toBe("show");
    expect(a.flags.receipt).toBe(true);
    expect(a.positional[0]).toBe("abc");
  });
  test("unknown flag throws", () => {
    expect(() => parseArgs(["chat", "--nope"])).toThrow(/unknown flag/);
  });
  test("skill alias", () => {
    expect(parseArgs(["skills", "list"]).command).toBe("skill");
  });
});
