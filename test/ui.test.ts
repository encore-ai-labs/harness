import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { observeHeadline, addedLines, wrapWords } from "../src/cli/work.ts";
import { formatObserveGroup, formatWorkEvent } from "../src/cli/render.ts";
import { imageFromBytes, sniffImage, imagePathsIn } from "../src/cli/image.ts";
import { osc1337File } from "../src/cli/clipboard.ts";
import { displayRows, visibleWidth } from "../src/cli/input.ts";
import { userMessage, textOf } from "../src/provider/types.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("work log", () => {
  test("observe headline matches Cursor phrasing", () => {
    const evs = [
      { name: "read", summary: "a", status: "ok" as const, args: { path: "src/a.ts" } },
      { name: "read", summary: "b", status: "ok" as const, args: { path: "src/b.ts" } },
      { name: "glob", summary: "g", status: "ok" as const, args: { pattern: "**/*.ts" } },
      { name: "grep", summary: "g", status: "ok" as const, args: { pattern: "foo" } },
    ];
    expect(observeHeadline(evs)).toBe("Read, globbed, grepped 2 files, 1 glob, 1 grep");
    const block = formatObserveGroup(evs);
    expect(block).toContain("src/a.ts");
    expect(block).toContain("Read, globbed, grepped");
  });

  test("hides earlier observe items", () => {
    const evs = Array.from({ length: 9 }, (_, i) => ({
      name: "read",
      summary: String(i),
      status: "ok" as const,
      args: { path: `f${i}.ts` },
    }));
    const block = formatObserveGroup(evs);
    expect(block).toMatch(/5 earlier items hidden/);
    expect(block).toContain("f8.ts");
    expect(block).not.toContain("f0.ts");
  });

  test("edit preview is +lines of new_string", () => {
    const ev = {
      name: "edit",
      summary: "ok",
      status: "ok" as const,
      args: { path: "src/skills/discover.ts", new_string: "alpha\nbeta\ngamma" },
    };
    expect(addedLines(ev).plus).toBe(3);
    const text = formatWorkEvent(ev);
    expect(text).toContain("Edited");
    expect(text).toContain("+3");
    expect(text).toContain("+ alpha");
  });
});

describe("images", () => {
  test("sniff png magic", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(imageFromBytes(PNG, "x.png")?.mime).toBe("image/png");
  });

  test("userMessage attaches input_image parts", () => {
    const img = imageFromBytes(PNG, "shot.png")!;
    const m = userMessage("look", { kind: "user" }, [img]);
    expect(Array.isArray(m.content)).toBe(true);
    const parts = m.content as Array<{ type: string; image_url?: string; text?: string }>;
    expect(parts[0]?.type).toBe("input_image");
    expect(parts[0]?.image_url?.startsWith("data:image/png;base64,")).toBe(true);
    expect(textOf(m)).toMatch(/look/);
  });

  test("image path tokens are stripped from the prompt", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-img-"));
    const p = join(dir, "a.png");
    writeFileSync(p, PNG);
    const r = imagePathsIn(`what is this ${p}`);
    expect(r.paths).toEqual([p]);
    expect(r.rest).toBe("what is this");
  });

  test("iTerm OSC 1337 file transfer", () => {
    const img = osc1337File(`File=name=x.png;size=${PNG.length}:${PNG.toString("base64")}`);
    expect(img?.mime).toBe("image/png");
    expect(img?.name).toBe("x.png");
  });
});

describe("wrapWords", () => {
  test("breaks on spaces", () => {
    const lines = wrapWords("one two three four", 10);
    expect(lines.every((l) => l.length <= 10)).toBe(true);
  });
});

describe("line editor wrap", () => {
  test("visibleWidth skips CSI", () => {
    expect(visibleWidth("\x1b[36m› \x1b[39mhi")).toBe(4);
  });
  test("displayRows counts wrapped rows so hide can erase them", () => {
    expect(displayRows("hello", 80)).toBe(1);
    expect(displayRows("a".repeat(80), 80)).toBe(1);
    expect(displayRows("a".repeat(81), 80)).toBe(2);
    const prompt = "› ";
    const msg =
      "i would love for you to take a deep dive into this codebase so you can understand how it works, and then recommend areas for how you would improve it.";
    expect(displayRows(prompt + msg, 40)).toBeGreaterThan(3);
  });
});
