/**
 * Failure classification.
 *
 * "Something failed, try again" is repetition, not recovery. Before the loop
 * decides what to do next it classifies the failure, and each class maps to a
 * different response. The hint is appended to the tool result the model sees,
 * so the model gets both the raw error and the harness's diagnosis.
 *
 *   tool_timeout        → retry once with a longer timeout / narrower command
 *   invalid_args        → repair the tool call (schema error, bad path)
 *   not_found           → missing context: retrieve the specific source first
 *   permission_denied   → policy said no: choose a safe path or ask for approval
 *   test_failed         → inspect the failing behaviour, do not just re-run
 *   command_failed      → non-zero exit: read stderr, fix cause
 *   repeated_failure    → the same call failed N times unchanged: stop the loop
 *   api_transient       → 429/5xx/network: backoff and retry (handled in provider)
 *   api_fatal           → 4xx auth/schema: stop, surface to human
 */

export type FailureClass =
  | "tool_timeout"
  | "invalid_args"
  | "not_found"
  | "permission_denied"
  | "test_failed"
  | "command_failed"
  | "repeated_failure"
  | "api_transient"
  | "api_fatal"
  | "unknown";

export const HINTS: Record<FailureClass, string> = {
  tool_timeout:
    "The tool timed out. Narrow the command (fewer files, a single test) or raise `timeout_ms` once. Do not repeat the identical call.",
  invalid_args:
    "The arguments were rejected before execution. Fix the call to match the tool schema and preconditions; nothing was changed.",
  not_found:
    "Something referenced does not exist. Retrieve the specific source first (ls/glob/grep) instead of guessing paths or names.",
  permission_denied:
    "Policy blocked this action. Choose a safe alternative inside the workspace, or explain to the user why approval is needed and stop.",
  test_failed:
    "Tests failed. Read the failing assertion and the code under test before changing anything; do not simply re-run.",
  command_failed: "The command exited non-zero. Read stderr, fix the cause, then re-run.",
  repeated_failure:
    "This exact call has failed repeatedly without change. Stop repeating it. Change strategy, or report the blocker to the user.",
  api_transient: "Transient API error; the harness retried with backoff.",
  api_fatal: "Fatal API error; the harness stopped.",
  unknown:
    "Unclassified failure. Inspect the output and change at least one relevant condition before retrying.",
};

export function classifyToolFailure(
  name: string,
  output: string,
  exitCode?: number,
  timedOut?: boolean,
): FailureClass {
  const o = output.toLowerCase();
  if (timedOut) return "tool_timeout";
  if (
    /\b(enoent|no such file|not found|does not exist|cannot find module|module not found)\b/.test(o)
  )
    return "not_found";
  if (
    /\b(eacces|eperm|permission denied|operation not permitted|blocked by policy|sandbox)\b/.test(o)
  )
    return "permission_denied";
  if (
    name === "bash" &&
    /\b(fail|failed|failing|assert|expected .* received|error:)/.test(o) &&
    /\b(test|spec|jest|vitest|bun test|pytest|mocha)\b/.test(o)
  )
    return "test_failed";
  if (name === "bash" && exitCode !== undefined && exitCode !== 0) return "command_failed";
  if (/\b(invalid|must be|required|schema|precondition)\b/.test(o)) return "invalid_args";
  return "unknown";
}

export function classifyApiError(status: number | null, message: string): FailureClass {
  if (status === null) return /abort/i.test(message) ? "api_fatal" : "api_transient";
  if (status === 429 || status >= 500) return "api_transient";
  if (status === 408) return "api_transient";
  return "api_fatal";
}

/**
 * Detects the "repeated unchanged failure" loop: same tool, same arguments,
 * failing again. Keyed on a stable serialization of (name, args).
 */
export type RepeatSnapshot = {
  failures: Record<string, number>;
  successes: Record<string, number>;
};

export class RepeatDetector {
  private failures = new Map<string, number>();
  private successes = new Map<string, number>();

  static from(data?: RepeatSnapshot | null): RepeatDetector {
    const d = new RepeatDetector();
    if (!data) return d;
    for (const [k, v] of Object.entries(data.failures ?? {})) d.failures.set(k, v);
    for (const [k, v] of Object.entries(data.successes ?? {})) d.successes.set(k, v);
    return d;
  }

  toJSON(): RepeatSnapshot {
    return {
      failures: Object.fromEntries(this.failures),
      successes: Object.fromEntries(this.successes),
    };
  }

  private key(name: string, args: unknown): string {
    return JSON.stringify([name, args]);
  }

  recordFailure(name: string, args: unknown): number {
    const k = this.key(name, args);
    const n = (this.failures.get(k) ?? 0) + 1;
    this.failures.set(k, n);
    return n;
  }

  recordSuccess(name: string, args: unknown): number {
    const k = this.key(name, args);
    this.failures.delete(k);
    const n = (this.successes.get(k) ?? 0) + 1;
    this.successes.set(k, n);
    return n;
  }

  reset() {
    this.failures.clear();
    this.successes.clear();
  }
}

/** Exponential backoff with jitter for transient API errors. */
export function backoffMs(attempt: number, base = 800, cap = 20_000): number {
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.round(exp * (0.6 + Math.random() * 0.8));
}
