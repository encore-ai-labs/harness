/**
 * bash: run a shell command in the workspace.
 *
 * What the gateway does around it (tools/index.ts): classifies every
 * sub-command (policy/policy.ts), decides allow/ask/deny, and if the call is
 * automatic in `auto` mode, wraps it in the seatbelt sandbox.
 *
 * What this file does: run it with a timeout, keep head+tail of the output
 * (Codex style: a big middle is the least informative part), spill the full
 * output to a file the model can grep (OpenCode style), and return exit code,
 * duration and a failure class as evidence.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyToolFailure } from "../recovery/classify.ts";
import { classifyBash } from "../policy/policy.ts";
import { sandboxAvailable, seatbeltCommand, looksLikeSandboxDenial } from "../policy/sandbox.ts";
import { type ToolDefinition, fail, ok } from "./types.ts";
import { resolveInWorkspace } from "./paths.ts";

export interface BashArgs {
  command: string;
  timeout_ms?: number;
  workdir?: string;
  description?: string;
}

const MAX_OUT = 40_000; // chars kept in context (head+tail)
const SPILL_AT = 40_000;

function headTail(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  const half = Math.floor(max / 2);
  const head = s.slice(0, half);
  const tail = s.slice(-half);
  const dropped = s.length - head.length - tail.length;
  return {
    text: `${head}\n\n…[${dropped} chars omitted from the middle]…\n\n${tail}`,
    truncated: true,
  };
}

export const bashTool: ToolDefinition<BashArgs> = {
  name: "bash",
  description:
    "Run a shell command in the workspace (zsh -c). Use it for builds, tests, git, package managers and other terminal " +
    "operations. Do NOT use it for reading, searching or editing files: use read/grep/glob/edit/apply_patch, which are faster, " +
    "safer and give better output. Output is capped (head+tail); if truncated, the full output is saved to a file you can grep. " +
    "Avoid `cd X && …`; pass `workdir` instead. Never run destructive commands (rm -rf, git reset --hard, git push --force): " +
    "the policy will refuse them. Commands that leave the machine (git push, curl, deploys) require user approval. " +
    "Only commit or push when the user explicitly asks.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line to run." },
      timeout_ms: { type: "integer", description: "Timeout in ms (default 120000, max 600000)." },
      workdir: {
        type: "string",
        description: "Working directory relative to the workspace (default: workspace root).",
      },
      description: {
        type: "string",
        description: "5-10 words on what this command does, shown to the user.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  risk: (a) => classifyBash(a.command ?? "").risk,
  summarize: (a) => a.command,
  precondition: (a, ctx) => {
    if (typeof a.command !== "string" || !a.command.trim()) return "command is required";
    if (a.command.length > 20_000) return "command too long";
    if (a.workdir) {
      const r = resolveInWorkspace(ctx.cwd, a.workdir);
      if ("error" in r) return r.error;
    }
    return null;
  },
  async execute(a, ctx) {
    const cwd = a.workdir
      ? (resolveInWorkspace(ctx.cwd, a.workdir) as { abs: string }).abs
      : ctx.cwd;
    const timeout = Math.min(
      600_000,
      Math.max(1_000, a.timeout_ms ?? ctx.config.budgets.bashTimeoutMs),
    );
    let argv = ["/bin/zsh", "-c", a.command];
    let sandboxed = false;
    if (ctx.sandboxed && sandboxAvailable()) {
      argv = seatbeltCommand(
        { cwd: ctx.cwd, writableRoots: ctx.config.writableRoots, network: ctx.config.network },
        argv,
      ).argv;
      sandboxed = true;
    }
    const t0 = Date.now();
    const proc = Bun.spawn(argv, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: {
        ...process.env,
        HARNESS: "1",
        CI: process.env.CI ?? "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        GIT_TERMINAL_PROMPT: "0",
        PAGER: "cat",
        GIT_PAGER: "cat",
      },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeout);
    const onAbort = () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onAbort);
    const ms = Date.now() - t0;

    let combined = stdout + (stderr ? (stdout ? "\n" : "") + stderr : "");
    let spilled: string | null = null;
    if (combined.length > SPILL_AT) {
      const dir = join(tmpdir(), "harness-output");
      mkdirSync(dir, { recursive: true });
      spilled = join(dir, `${ctx.sessionId}-t${ctx.turn}-${Date.now()}.log`);
      writeFileSync(spilled, combined);
    }
    const { text, truncated } = headTail(combined, MAX_OUT);
    let out = text.trimEnd();
    if (truncated)
      out += `\n[output truncated; full ${combined.length} chars saved to ${spilled}. Use grep/read on it; do not re-run just to see more.]`;
    if (timedOut) out += `\n[killed after ${timeout}ms timeout]`;
    out += `\n[exit ${code}${timedOut ? " (timeout)" : ""}, ${ms}ms${sandboxed ? ", sandboxed" : ""}]`;

    const evidence = {
      command: a.command,
      exitCode: code,
      ms,
      sandboxed,
      timedOut,
      stdoutChars: stdout.length,
      stderrChars: stderr.length,
      spilled,
    };
    if (code === 0 && !timedOut) return ok(out, { evidence, summary: `exit 0 in ${ms}ms` });

    let failureClass = classifyToolFailure("bash", combined, code, timedOut);
    if (sandboxed && looksLikeSandboxDenial(combined)) {
      failureClass = "permission_denied";
      out += `\n[this command ran inside the sandbox (no network, writes limited to the workspace and tmp). If it genuinely needs more, say so and the user can approve an unsandboxed run.]`;
    }
    return fail(out, failureClass, { evidence, summary: timedOut ? "timeout" : `exit ${code}` });
  },
};
