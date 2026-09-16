import { describe, expect, test } from "bun:test";
import { validate } from "../src/tools/schema.ts";
import { resolveInWorkspace } from "../src/tools/paths.ts";

describe("schema", () => {
  const schema = {
    type: "object",
    properties: { path: { type: "string" }, n: { type: "integer" } },
    required: ["path"],
    additionalProperties: false,
  };
  test("accepts valid", () => {
    expect(validate(schema, { path: "a.ts" })).toEqual([]);
  });
  test("null does not bypass type", () => {
    expect(validate(schema, { path: null }).join(" ")).toMatch(/must not be null/);
  });
  test("rejects extra keys", () => {
    expect(validate(schema, { path: "a", extra: 1 }).length).toBeGreaterThan(0);
  });
});

describe("paths", () => {
  const cwd = "/tmp/ws";
  test("stays in workspace", () => {
    const r = resolveInWorkspace(cwd, "src/a.ts");
    expect("abs" in r).toBe(true);
  });
  test("blocks escape", () => {
    expect("error" in resolveInWorkspace(cwd, "../x")).toBe(true);
  });
  test("blocks .git", () => {
    expect("error" in resolveInWorkspace(cwd, ".git/config")).toBe(true);
    expect("error" in resolveInWorkspace(cwd, "foo/.git/hooks")).toBe(true);
  });
  test("blocks .harness", () => {
    expect("error" in resolveInWorkspace(cwd, ".harness/state.json")).toBe(true);
  });
});
