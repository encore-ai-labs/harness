import { describe, expect, test } from "bun:test";
import { classifyBash, Policy } from "../src/policy/policy.ts";
import { loadConfig } from "../src/config.ts";
import { parseShell } from "../src/policy/shell.ts";

const cfg = (over: Record<string, unknown> = {}) => loadConfig(process.cwd(), over as any);

describe("classifyBash", () => {
  test("ls is read", () => {
    expect(classifyBash("ls -la src").risk).toBe("read");
  });
  test("awk print to stdout is read", () => {
    expect(classifyBash("awk '{print $1}' file").risk).toBe("read");
  });
  test("awk write-form is not read", () => {
    expect(classifyBash("awk -i inplace '{print}' file").risk).not.toBe("read");
  });
  test("gh api without method is external", () => {
    expect(classifyBash("gh api repos/x/y -f title=hi").risk).toBe("external");
  });
  test("gh api GET is not blindly read-classified via allow-all api", () => {
    const c = classifyBash("gh api user");
    expect(c.risk).toBe("external");
  });
  test("opaque nested shell is external", () => {
    expect(classifyBash("bash -c 'rm -rf /tmp/x'").opaque).toBe(true);
    expect(classifyBash("bash -c 'echo hi'").risk).toBe("external");
    expect(classifyBash("echo $(cat secret)").opaque).toBe(true);
  });
  test("git push is external", () => {
    expect(classifyBash("git push origin main").risk).toBe("external");
  });
  test("rm -rf is irreversible", () => {
    expect(classifyBash("rm -rf src").risk).toBe("irreversible");
  });
});

describe("Policy", () => {
  test("edit allows reversible, asks external", () => {
    const p = new Policy(cfg({ mode: "edit" }), "edit", true);
    expect(p.decide("write", "reversible").action).toBe("allow");
    expect(p.decide("bash", "external").action).toBe("ask");
  });
  test("non-interactive ask becomes deny", () => {
    const p = new Policy(cfg({ mode: "edit" }), "edit", false);
    const d = p.decide("bash", "external", { reasons: ["network"] });
    expect(d.action).toBe("deny");
    expect(d.reason).toMatch(/APPROVAL NEEDED|non-interactive/);
  });
  test("allow-list does not disable sandbox in auto", () => {
    const base = cfg({ mode: "auto", sandbox: true });
    base.permissions.allow = ["bun test *"];
    const p = new Policy(base, "auto", true);
    const d = p.decide("bash", "reversible", { bashCommands: ["bun test foo"] });
    expect(d.action === "allow" || d.action === "deny").toBe(true);
    if (d.action === "allow") expect(d.sandbox).toBe(true);
    else expect(d.reason).toMatch(/sandbox/);
  });
  test("plan mode denies writes", () => {
    const p = new Policy(cfg({ mode: "plan" }), "plan", true);
    expect(p.decide("write", "reversible").action).toBe("deny");
  });
});

describe("parseShell", () => {
  test("splits &&", () => {
    expect(parseShell("ls && pwd").commands.map((c) => c.argv[0])).toEqual(["ls", "pwd"]);
  });
});
