/**
 * Config: defaults → ~/.config/harness/config.json → <cwd>/.harness/config.json → env → CLI flags.
 *
 * Everything the harness enforces (budgets, policy, sandbox) lives here, not in the prompt.
 * The prompt explains judgment; the harness enforces invariants.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Approval mode. Maps risk class → automatic / ask / blocked. See policy/policy.ts. */
export type Mode = "ask" | "edit" | "auto" | "plan";

export interface Budgets {
  /** Max model round-trips per user request before the loop stops and escalates. */
  maxTurns: number;
  /** Max USD per session (estimated from usage × pricing). */
  maxCostUsd: number;
  /** Max wall-clock minutes per user request. */
  maxMinutes: number;
  /** Max verifier reject→repair rounds before escalating to the human. */
  maxVerifyRounds: number;
  /** Max identical failing tool calls before the loop refuses to repeat itself. */
  maxRepeatedFailures: number;
  /** Max API retries on transient errors (429/5xx/network). */
  maxApiRetries: number;
  /** Default tool timeout. */
  toolTimeoutMs: number;
  /** Bash command timeout. */
  bashTimeoutMs: number;
}

export interface Pricing {
  /** USD per 1M tokens. */
  input: number;
  output: number;
  cachedInput?: number;
}

export interface Config {
  /** Worker model id. */
  model: string;
  /** Model used for the adversarial verifier. Defaults to the strongest model: verification is where quality matters most. */
  verifierModel: string;
  /**
   * Model used for short structured side jobs: contract drafting, compaction
   * summaries, receipt notes. grok-4.5 is cheaper on cached input and these jobs
   * do not need the worker's full strength.
   */
  helperModel: string;
  baseUrl: string;
  apiKey: string;
  mode: Mode;
  contract: "auto" | "always" | "never";
  /** Run bash inside a macOS seatbelt sandbox when it would run automatically. */
  sandbox: boolean;
  /** Allow network inside the sandbox. */
  network: boolean;
  /** Extra directories the sandbox may write to (besides cwd and tmp). */
  writableRoots: string[];
  /** Enable xAI server-side tools (web search etc.) if the API supports them. */
  serverTools: boolean;
  /** xAI reasoning effort. Default (unset) lets the API choose ("high" on grok-4.6). */
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  budgets: Budgets;
  context: {
    /** Model context window in tokens. */
    window: number;
    /**
     * Approx prompt tokens at which we compact history into durable state.
     * grok-4.6 bills every token in a request at 2x once the prompt reaches 200k,
     * so we compact well before that line. Cost, not capacity, sets this.
     */
    compactAtTokens: number;
    /** Max characters of a single tool result kept in context. */
    maxToolOutputChars: number;
    /**
     * Tool outputs older than this many turns are pruned to a stub. Pruning is
     * batched (see agent/context.ts) because every edit to history invalidates
     * the provider's prefix cache from that point on.
     */
    pruneAfterTurns: number;
    /** Only prune once at least this many chars would be reclaimed (batch the cache invalidation). */
    pruneMinChars: number;
  };
  permissions: {
    /** Glob-ish patterns for bash commands that never need approval, e.g. "bun test*". */
    allow: string[];
    /** Patterns that are always refused, even in auto mode. */
    deny: string[];
  };
  pricing: Record<string, Pricing>;
  /** Instruction files searched for in cwd and parents. */
  instructionFiles: string[];
}

export const DEFAULTS: Config = {
  model: "grok-4.6",
  verifierModel: "grok-4.6",
  helperModel: "grok-4.5",
  baseUrl: "https://api.x.ai/v1",
  apiKey: "",
  mode: "edit",
  contract: "auto",
  sandbox: true,
  network: false,
  writableRoots: [],
  serverTools: false,
  budgets: {
    maxTurns: 80,
    maxCostUsd: 5,
    maxMinutes: 30,
    maxVerifyRounds: 2,
    maxRepeatedFailures: 3,
    maxApiRetries: 4,
    toolTimeoutMs: 60_000,
    bashTimeoutMs: 120_000,
  },
  context: {
    window: 500_000,
    compactAtTokens: 160_000,
    maxToolOutputChars: 30_000,
    pruneAfterTurns: 12,
    pruneMinChars: 40_000,
  },
  permissions: {
    allow: [],
    deny: ["git push --force*", "git push -f*", "rm -rf /*", "rm -rf ~*"],
  },
  // USD per 1M tokens, <200k-prompt tier (docs.x.ai/developers/pricing, 2026-09). The API also
  // returns exact cost per request (usage.cost_in_nano_usd); this table is the fallback.
  pricing: {
    "grok-4.6": { input: 2.0, cachedInput: 0.5, output: 6.0 },
    "grok-4.5": { input: 2.0, cachedInput: 0.3, output: 6.0 },
    "grok-4.3": { input: 1.25, cachedInput: 0.2, output: 2.5 },
    "grok-build-0.1": { input: 1.0, cachedInput: 0.2, output: 2.0 },
  },
  instructionFiles: ["AGENTS.md", "HARNESS.md", "CLAUDE.md", ".harness/instructions.md"],
};

function readJson(path: string): Partial<Config> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    process.stderr.write(`warning: could not parse ${path}: ${(e as Error).message}\n`);
    return null;
  }
}

function merge<T extends object>(base: T, over: Partial<T> | null | undefined): T {
  if (!over) return base;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof (base as any)[k] === "object" &&
      !Array.isArray((base as any)[k])
    ) {
      out[k] = merge((base as any)[k], v as any);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export interface CliOverrides {
  model?: string;
  mode?: Mode;
  contract?: Config["contract"];
  sandbox?: boolean;
  network?: boolean;
  maxCostUsd?: number;
  maxTurns?: number;
  reasoningEffort?: Config["reasoningEffort"];
}

export function loadConfig(cwd: string, cli: CliOverrides = {}): Config {
  let cfg = DEFAULTS;
  cfg = merge(cfg, readJson(join(homedir(), ".config", "harness", "config.json")));
  cfg = merge(cfg, readJson(join(cwd, ".harness", "config.json")));

  const env = process.env;
  if (env.XAI_API_KEY) cfg = { ...cfg, apiKey: env.XAI_API_KEY };
  if (env.XAI_BASE_URL) cfg = { ...cfg, baseUrl: env.XAI_BASE_URL };
  if (env.HARNESS_MODEL) cfg = { ...cfg, model: env.HARNESS_MODEL };
  if (env.HARNESS_MODE) cfg = { ...cfg, mode: env.HARNESS_MODE as Mode };

  if (cli.model) cfg = { ...cfg, model: cli.model };
  if (cli.mode) cfg = { ...cfg, mode: cli.mode };
  if (cli.contract) cfg = { ...cfg, contract: cli.contract };
  if (cli.sandbox !== undefined) cfg = { ...cfg, sandbox: cli.sandbox };
  if (cli.network !== undefined) cfg = { ...cfg, network: cli.network };
  if (cli.reasoningEffort) cfg = { ...cfg, reasoningEffort: cli.reasoningEffort };
  if (cli.maxCostUsd !== undefined)
    cfg = { ...cfg, budgets: { ...cfg.budgets, maxCostUsd: cli.maxCostUsd } };
  if (cli.maxTurns !== undefined)
    cfg = { ...cfg, budgets: { ...cfg.budgets, maxTurns: cli.maxTurns } };

  return cfg;
}

/** Cost in USD for a usage record, 0 if the model is not priced. */
export function estimateCost(
  cfg: Config,
  model: string,
  usage: { input_tokens: number; output_tokens: number; cached_tokens?: number; cost_usd?: number },
): number {
  if (usage.cost_usd !== undefined) return usage.cost_usd;
  const p = cfg.pricing[model];
  if (!p) return 0;
  const cached = usage.cached_tokens ?? 0;
  const fresh = Math.max(0, usage.input_tokens - cached);
  const cachedRate = p.cachedInput ?? p.input;
  const reasoning = (usage as { reasoning_tokens?: number }).reasoning_tokens ?? 0;
  const billedOutput = usage.output_tokens + reasoning;
  const mult = usage.input_tokens >= 200_000 ? 2 : 1;
  return (mult * (fresh * p.input + cached * cachedRate + billedOutput * p.output)) / 1_000_000;
}
