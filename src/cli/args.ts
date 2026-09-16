/**
 * Argv parser. No deps: flags already documented on CliOverrides.
 */
import type { CliOverrides, Mode } from "../config.ts";

export type Command = "chat" | "run" | "resume" | "sessions" | "rewind" | "show" | "skill" | "help";

export interface Args {
  command: Command;
  positional: string[];
  flags: CliOverrides & {
    receipt?: boolean;
    trace?: boolean;
    help?: boolean;
    force?: boolean;
    project?: boolean;
  };
}

const MODES = new Set<Mode>(["ask", "edit", "auto", "plan"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const CONTRACTS = new Set(["auto", "always", "never"]);

export function parseArgs(argv: string[]): Args {
  const flags: Args["flags"] = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i];
    if (a === "-h" || a === "--help") flags.help = true;
    else if (a === "--model") flags.model = next();
    else if (a.startsWith("--model=")) flags.model = a.slice(8);
    else if (a === "--mode") flags.mode = asMode(next());
    else if (a.startsWith("--mode=")) flags.mode = asMode(a.slice(7));
    else if (a === "--contract") flags.contract = asContract(next());
    else if (a.startsWith("--contract=")) flags.contract = asContract(a.slice(11));
    else if (a === "--sandbox") flags.sandbox = true;
    else if (a === "--no-sandbox") flags.sandbox = false;
    else if (a === "--network") flags.network = true;
    else if (a === "--no-network") flags.network = false;
    else if (a === "--max-cost") flags.maxCostUsd = Number(next());
    else if (a.startsWith("--max-cost=")) flags.maxCostUsd = Number(a.slice(11));
    else if (a === "--max-turns") flags.maxTurns = Number(next());
    else if (a.startsWith("--max-turns=")) flags.maxTurns = Number(a.slice(12));
    else if (a === "--effort") flags.reasoningEffort = asEffort(next());
    else if (a.startsWith("--effort=")) flags.reasoningEffort = asEffort(a.slice(9));
    else if (a === "--receipt") flags.receipt = true;
    else if (a === "--trace") flags.trace = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--project") flags.project = true;
    else if (a.startsWith("-") && a !== "-") throw new Error(`unknown flag ${a}`);
    else positional.push(a);
  }
  const raw = positional[0];
  const command = (raw === "skills" ? "skill" : (raw as Command | undefined)) ?? "chat";
  if (!["chat", "run", "resume", "sessions", "rewind", "show", "skill", "help"].includes(command)) {
    throw new Error(`unknown command ${command}`);
  }
  return { command: flags.help ? "help" : command, positional: positional.slice(1), flags };
}

function asMode(v: string | undefined): Mode {
  if (!v || !MODES.has(v as Mode)) throw new Error(`--mode must be ask|edit|auto|plan`);
  return v as Mode;
}
function asEffort(v: string | undefined): NonNullable<CliOverrides["reasoningEffort"]> {
  if (!v || !EFFORTS.has(v)) throw new Error(`--effort must be low|medium|high|xhigh`);
  return v as NonNullable<CliOverrides["reasoningEffort"]>;
}
function asContract(v: string | undefined): NonNullable<CliOverrides["contract"]> {
  if (!v || !CONTRACTS.has(v)) throw new Error(`--contract must be auto|always|never`);
  return v as NonNullable<CliOverrides["contract"]>;
}

export const HELP = `harness — a local coding agent around Grok

Usage:
  harness chat [prompt]          interactive (default). Type another line to steer.
  harness run "<task>"           non-interactive, verifies
  harness resume [session-id]    continue the latest or named session
  harness sessions               list sessions (no API key)
  harness rewind <sha>           restore a checkpoint
  harness show [id] --receipt|--trace
  harness skill                  list installed Agent Skills
  harness skill add <src>        install (GitHub owner/repo or local path)
  harness skill remove <name>    uninstall from ~/.harness/skills

Flags:
  --model ID           worker model (default grok-4.6)
  --mode ask|edit|auto|plan
  --contract auto|always|never
  --sandbox / --no-sandbox
  --network / --no-network
  --max-cost USD
  --max-turns N
  --effort low|medium|high|xhigh
  --force              overwrite an existing skill
  --project            install skill into .harness/skills (this repo)
`;
