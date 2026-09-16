/**
 * Policy: the model proposes, the policy authorizes.
 *
 * Nothing here depends on the model remembering a rule. Every tool call passes
 * through `decide()` which returns one of:
 *
 *   allow    run automatically (with a trace)
 *   ask      the human must approve this call
 *   deny     refused; the model gets a structured error
 *
 * Inputs are the tool's risk class (possibly derived from the arguments, e.g.
 * bash classifies each sub-command), the session mode, and user rules.
 *
 *   mode     read        reversible   external   irreversible
 *   ask      allow       ask          ask        ask (typed confirmation)
 *   edit     allow       allow        ask        ask (typed confirmation)
 *   auto     allow       allow*       ask        ask (typed confirmation)
 *   plan     allow       deny         deny       deny
 *
 *   * in auto mode, bash runs inside the seatbelt sandbox (no network, writes
 *     only in the workspace and tmp). If the sandbox blocks it, the model gets
 *     the failure and may ask for escalation, which is an `ask`.
 *
 * Non-interactive runs (`harness run`) cannot ask: `ask` becomes `deny`, and the
 * denial is recorded in the receipt under APPROVAL NEEDED.
 *
 * User rules: config.permissions.allow / deny are glob-ish patterns matched
 * against each bash sub-command (`git push *`, `bun test*`). Deny always wins,
 * even in auto mode. "Always allow" answers at the prompt add session rules
 * with the same shape (prefix + " *"), the way OpenCode's arity table does.
 */
import type { Config, Mode } from "../config.ts";
import type { RiskClass } from "../tools/types.ts";
import { parseShell } from "./shell.ts";
import { sandboxAvailable } from "./sandbox.ts";

export type Decision = { action: "allow" | "ask" | "deny"; reason: string; sandbox?: boolean };

/** Programs whose invocation only observes. Arguments are still checked for write-ish flags below. */
const READ_ONLY = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "stat",
  "file",
  "du",
  "df",
  "pwd",
  "echo",
  "printf",
  "true",
  "false",
  "which",
  "whereis",
  "type",
  "env",
  "printenv",
  "date",
  "uname",
  "id",
  "whoami",
  "hostname",
  "uptime",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "find",
  "fd",
  "tree",
  "sort",
  "uniq",
  "cut",
  "tr",
  "awk",
  "sed",
  "diff",
  "cmp",
  "comm",
  "jq",
  "yq",
  "xxd",
  "hexdump",
  "od",
  "base64",
  "md5",
  "md5sum",
  "shasum",
  "sha256sum",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "test",
  "[",
  "column",
  "nl",
  "tac",
  "rev",
  "seq",
  "expr",
  "bc",
  "sleep",
]);

/** Subcommands of common tools that only read. */
const READ_ONLY_SUB: Record<string, Set<string>> = {
  git: new Set([
    "status",
    "diff",
    "log",
    "show",
    "branch",
    "blame",
    "rev-parse",
    "ls-files",
    "ls-tree",
    "cat-file",
    "describe",
    "shortlog",
    "remote",
    "tag",
    "stash list",
    "config --get",
    "grep",
    "reflog",
    "worktree list",
    "check-ignore",
  ]),
  bun: new Set(["--version", "pm ls"]),
  npm: new Set(["ls", "list", "view", "info", "outdated", "--version", "-v"]),
  pnpm: new Set(["ls", "list", "why", "--version"]),
  cargo: new Set(["--version", "metadata", "tree"]),
  go: new Set(["version", "env", "list"]),
  python: new Set(["--version", "-V"]),
  python3: new Set(["--version", "-V"]),
  node: new Set(["--version", "-v"]),
  docker: new Set(["ps", "images", "version", "info"]),
  gh: new Set([
    "pr view",
    "pr list",
    "pr diff",
    "pr checks",
    "issue view",
    "issue list",
    "repo view",
    "run list",
    "run view",
  ]),
};

/** Commands that run code in the workspace and may write to it, but are the normal dev loop. */
const REVERSIBLE_DEV = new Set([
  "bun",
  "bunx",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "node",
  "deno",
  "tsc",
  "python",
  "python3",
  "pytest",
  "uv",
  "pip",
  "pip3",
  "poetry",
  "cargo",
  "rustc",
  "go",
  "make",
  "cmake",
  "gradle",
  "mvn",
  "swift",
  "xcodebuild",
  "prettier",
  "eslint",
  "biome",
  "ruff",
  "black",
  "mypy",
  "jest",
  "vitest",
  "mocha",
  "mkdir",
  "touch",
  "cp",
  "mv",
  "ln",
  "chmod",
  "tar",
  "zip",
  "unzip",
  "gzip",
  "sed",
  "awk",
  "tee",
  "patch",
  "git",
]);

/** Anything that can leave the machine or the workspace. */
function isExternal(argv: string[]): string | null {
  const [p = "", ...rest] = argv;
  const sub = rest.join(" ");
  if (p === "git" && /^(push|fetch|pull|clone|remote add|remote set-url|submodule)/.test(sub))
    return `git ${rest[0]} touches a remote`;
  if (p === "gh") {
    const pair = rest.slice(0, 2).join(" ");
    if (READ_ONLY_SUB.gh!.has(pair)) return null;
    if (
      rest[0] === "api" &&
      rest.some(
        (a, i) =>
          (a === "-X" && /^(POST|PUT|PATCH|DELETE)$/i.test(rest[i + 1] ?? "")) ||
          /^--method=(POST|PUT|PATCH|DELETE)$/i.test(a),
      )
    ) {
      return "gh api mutates GitHub";
    }
    if (
      rest[0] === "api" &&
      rest.some(
        (a) =>
          (a === "-X" && /^(GET|HEAD)$/i.test(rest[rest.indexOf(a) + 1] ?? "")) ||
          /^--method=(GET|HEAD)$/i.test(a) ||
          (a === "--method" && /^(GET|HEAD)$/i.test(rest[rest.indexOf(a) + 1] ?? "")),
      )
    ) {
      return null;
    }
    if (rest[0] === "api") return "gh api may mutate GitHub";
    return "gh mutates GitHub";
  }
  if (
    [
      "curl",
      "wget",
      "http",
      "httpie",
      "nc",
      "ncat",
      "ssh",
      "scp",
      "rsync",
      "sftp",
      "ftp",
      "telnet",
    ].includes(p)
  )
    return `${p} talks to the network`;
  if (
    ["npm", "pnpm", "yarn", "bun"].includes(p) &&
    /^(publish|deploy|login|adduser|token|owner|dist-tag)/.test(sub)
  )
    return `${p} ${rest[0]} publishes`;
  if (["cargo"].includes(p) && /^(publish|login)/.test(sub)) return "cargo publish";
  if (["pip", "pip3", "uv", "poetry"].includes(p) && /^(publish|upload)/.test(sub))
    return "package publish";
  if (
    [
      "docker",
      "kubectl",
      "helm",
      "terraform",
      "pulumi",
      "aws",
      "gcloud",
      "az",
      "vercel",
      "netlify",
      "fly",
      "flyctl",
      "heroku",
      "wrangler",
      "eas",
      "fastlane",
    ].includes(p)
  )
    return `${p} controls infrastructure`;
  if (["mail", "sendmail", "osascript", "open"].includes(p))
    return `${p} has side effects outside the workspace`;
  if (["brew", "apt", "apt-get", "yum", "dnf", "pacman", "port"].includes(p))
    return `${p} changes the system`;
  if (["npm", "pnpm", "yarn", "bun"].includes(p) && /(-g|--global)\b/.test(sub))
    return "global install";
  return null;
}

/** Destroys data or cannot be undone with a checkpoint. */
function isIrreversible(argv: string[], raw: string): string | null {
  const [p = "", ...rest] = argv;
  const sub = rest.join(" ");
  if (p === "sudo" || p === "doas" || p === "su") return "privilege escalation";
  if (p === "rm" && /(^|\s)-[a-zA-Z]*[rRf]/.test(sub)) return "rm with -r/-f";
  if (p === "rm" && /(\s|^)(\/|~|\*|\.\.)(\s|$)/.test(sub)) return "rm on a root-like path";
  if (
    p === "git" &&
    /^(reset --hard|clean -[a-zA-Z]*f|push .*(--force|-f\b)|branch -D|checkout -- \.|restore \.|stash drop|stash clear|filter-branch|reflog expire|gc --prune)/.test(
      sub,
    )
  )
    return `git ${rest[0]} discards history or work`;
  if (["mkfs", "dd", "fdisk", "diskutil", "shred", "wipe", "format"].includes(p))
    return `${p} destroys data`;
  if (p === "chmod" && /-R/.test(sub) && /\s(\/|~)(\s|$)/.test(sub))
    return "recursive chmod on root/home";
  if (p === "chown" && /-R/.test(sub)) return "recursive chown";
  if (p === "kill" && /-9\s+-1|(^|\s)-1(\s|$)/.test(sub)) return "kill all processes";
  if (["killall", "pkill"].includes(p)) return `${p} kills processes by name`;
  if (/(^|\s)>\s*\/dev\/(sd|disk|nvme)/.test(raw)) return "writing to a device";
  if (/\b(drop\s+(table|database|schema)|truncate\s+table|delete\s+from\s+\w+\s*;?\s*$)/i.test(raw))
    return "destructive SQL";
  if (["launchctl", "systemctl", "crontab", "defaults", "csrutil", "nvram"].includes(p))
    return `${p} changes system state`;
  return null;
}

function isReadOnly(argv: string[]): boolean {
  const [p = "", ...rest] = argv;
  if (!p) return true;
  if (READ_ONLY.has(p)) {
    if (p === "sed" && rest.some((a) => /^-[a-zA-Z]*i/.test(a))) return false;
    if (
      p === "awk" &&
      rest.some((a) => a === "-i" || />/.test(a) || /print\s*>/.test(rest.join(" ")))
    )
      return false;
    if (p === "find" && rest.some((a) => a === "-delete" || a === "-exec" || a === "-execdir"))
      return false;
    return true;
  }
  const subs = READ_ONLY_SUB[p];
  if (subs) {
    for (let n = 3; n >= 1; n--) if (subs.has(rest.slice(0, n).join(" "))) return true;
    if (rest.some((a) => a === "--help" || a === "-h" || a === "--version")) return true;
  }
  return false;
}

export interface BashClassification {
  risk: RiskClass;
  reasons: string[];
  /** patterns for "always allow" prompts, one per sub-command: `git push *` */
  patterns: string[];
  opaque: boolean;
}

/** Classify a whole command line: the riskiest sub-command wins. */
export function classifyBash(command: string): BashClassification {
  const parsed = parseShell(command);
  let risk: RiskClass = "read";
  const reasons: string[] = [];
  const patterns: string[] = [];
  const bump = (r: RiskClass) => {
    const order: RiskClass[] = ["read", "reversible", "external", "irreversible"];
    if (order.indexOf(r) > order.indexOf(risk)) risk = r;
  };
  if (parsed.opaque) {
    bump("external");
    reasons.push(`opaque shell constructs: ${parsed.reasons.join(", ")}`);
  }
  for (const c of parsed.commands) {
    const argv = c.argv;
    const p = argv[0] ?? "";
    patterns.push(prefixPattern(argv));
    const irr = isIrreversible(argv, c.raw);
    if (irr) {
      bump("irreversible");
      reasons.push(irr);
      continue;
    }
    const ext = isExternal(argv);
    if (ext) {
      bump("external");
      reasons.push(ext);
      continue;
    }
    if (isReadOnly(argv)) continue;
    if (REVERSIBLE_DEV.has(p)) {
      bump("reversible");
      continue;
    }
    // Unknown program: treat as reversible workspace change (sandboxed in auto mode).
    bump("reversible");
    reasons.push(`unknown program ${p}`);
  }
  if (parsed.commands.length === 0) bump("reversible");
  return {
    risk,
    reasons: [...new Set(reasons)],
    patterns: [...new Set(patterns)],
    opaque: parsed.opaque,
  };
}

/** "git push origin main" → "git push *"; "bun test foo" → "bun test *"; "ls -la" → "ls *". */
export function prefixPattern(argv: string[]): string {
  const [p = "", a1 = ""] = argv;
  const twoWord = new Set([
    "git",
    "gh",
    "npm",
    "pnpm",
    "yarn",
    "bun",
    "cargo",
    "go",
    "docker",
    "kubectl",
    "uv",
    "pip",
    "poetry",
    "make",
    "python",
    "python3",
  ]);
  if (twoWord.has(p) && a1 && !a1.startsWith("-")) return `${p} ${a1} *`;
  return p ? `${p} *` : "*";
}

/** Glob-ish match: `*` matches anything, `?` one char; anchored on both ends. */
export function matchPattern(pattern: string, text: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .split("*")
        .map((s) =>
          s
            .split("?")
            .map((x) => x.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
            .join("."),
        )
        .join(".*") +
      "$",
    "s",
  );
  return re.test(text);
}

export class Policy {
  /** Session-scoped allow rules added by "always allow" answers. */
  private sessionAllow: string[] = [];

  constructor(
    private cfg: Config,
    public mode: Mode,
    public interactive: boolean,
  ) {}

  addSessionAllow(pattern: string) {
    if (!this.sessionAllow.includes(pattern)) this.sessionAllow.push(pattern);
  }

  /** User rules apply to bash sub-commands (raw text of each simple command). */
  private userRule(commands: string[]): "allow" | "deny" | null {
    for (const c of commands)
      for (const d of this.cfg.permissions.deny) if (matchPattern(d, c)) return "deny";
    const allowed =
      commands.length > 0 &&
      commands.every((c) =>
        [...this.cfg.permissions.allow, ...this.sessionAllow].some((a) => matchPattern(a, c)),
      );
    return allowed ? "allow" : null;
  }

  decide(
    tool: string,
    risk: RiskClass,
    opts: { bashCommands?: string[]; reasons?: string[] } = {},
  ): Decision {
    const why = opts.reasons?.length ? ` (${opts.reasons.join("; ")})` : "";
    if (tool === "bash" && opts.bashCommands) {
      const rule = this.userRule(opts.bashCommands);
      if (rule === "deny")
        return { action: "deny", reason: "matches a deny rule in config.permissions.deny" };
      if (rule === "allow" && risk !== "irreversible")
        return {
          action: "allow",
          reason: "matches an allow rule",
          sandbox: tool === "bash" && this.cfg.sandbox && this.mode === "auto",
        };
    }
    if (this.mode === "plan" && risk !== "read")
      return {
        action: "deny",
        reason: "plan mode: read-only. Propose the change instead of making it.",
      };
    if (risk === "read") return { action: "allow", reason: "read-only" };

    let action: Decision["action"];
    let sandbox = false;
    if (risk === "irreversible") action = "ask";
    else if (risk === "external") action = "ask";
    else if (this.mode === "ask") action = "ask";
    else {
      action = "allow";
      sandbox = tool === "bash" && this.cfg.sandbox && this.mode === "auto";
    }

    if (action === "allow" && sandbox && !sandboxAvailable()) {
      return {
        action: "deny",
        reason: "auto mode requested a sandbox, but sandbox-exec is not available on this machine",
      };
    }

    if (action === "ask" && !this.interactive) {
      return {
        action: "deny",
        reason: `${risk} action requires approval${why}, and this run is non-interactive. Recorded as APPROVAL NEEDED.`,
      };
    }
    return { action, reason: `${risk}${why}`, sandbox };
  }
}
