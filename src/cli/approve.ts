/**
 * Interactive approvals. Irreversible actions require typing "yes".
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ApprovalAnswer, ApprovalRequest } from "../tools/index.ts";
import { c, line, box } from "./render.ts";

export async function askApproval(req: ApprovalRequest): Promise<ApprovalAnswer> {
  const title = req.escalation ? "sandbox blocked — rerun unsandboxed?" : `${req.risk} ${req.tool}`;
  line(
    box(
      title,
      `${req.summary}\n${c.dim(req.reason)}`,
      req.risk === "irreversible" ? c.red : c.yellow,
    ),
  );
  const rl = createInterface({ input, output });
  try {
    if (req.risk === "irreversible" && !req.escalation) {
      const ans = (await rl.question(`Type ${c.bold("yes")} to allow this irreversible action: `))
        .trim()
        .toLowerCase();
      if (ans === "yes") return { kind: "once" };
      const feedback = ans && ans !== "n" && ans !== "no" ? ans : undefined;
      return { kind: "reject", feedback };
    }
    const hint = req.alwaysPatterns.length
      ? ` [y]es / [n]o / [a]lways (${req.alwaysPatterns[0]})`
      : " [y]es / [n]o";
    const ans = (await rl.question(`Allow?${hint} `)).trim().toLowerCase();
    if (ans === "y" || ans === "yes") return { kind: "once" };
    if (ans === "a" || ans === "always" || ans === "!") return { kind: "always" };
    const feedback = ans && ans !== "n" && ans !== "no" ? ans : undefined;
    return { kind: "reject", feedback };
  } finally {
    rl.close();
  }
}
