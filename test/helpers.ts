import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, silentUi, type Runtime } from "../src/agent/loop.ts";
import { FakeClient } from "../src/provider/fake.ts";
import type { CompletionResult } from "../src/provider/types.ts";
import type { CliOverrides } from "../src/config.ts";

export function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "hello.ts"), "export const n = 1;\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "toy", scripts: { test: "bun test" } }),
  );
  return dir;
}

export async function bootFake(
  dir: string,
  queue: CompletionResult[],
  cli: CliOverrides = {},
  extra: { interactive?: boolean; kind?: "chat" | "run"; sessionId?: string } = {},
): Promise<Runtime> {
  return boot({
    cwd: dir,
    cli: { contract: "never", sandbox: false, ...cli },
    interactive: extra.interactive ?? false,
    kind: extra.kind ?? "chat",
    sessionId: extra.sessionId,
    client: new FakeClient(queue),
    ui: silentUi,
  });
}
