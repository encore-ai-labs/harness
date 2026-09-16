/**
 * Prompt assembly. Two layers so the prefix cache stays warm:
 *
 *   instructions  stable for the session: identity, mode, map, contract, instruction files
 *   reminder      trailing, ephemeral, not persisted. Only attached when there is
 *                 something to say: workspace drift, or plan/state after compact.
 *                 Budget lives in the spinner and `/cost`, not here.
 *
 * Editing the middle of history is a speed bug. The reminder is appended only
 * to the projected input for this request. An empty reminder is omitted entirely
 * so Grok does not treat a per-turn status ping as the user talking.
 */
import type { Config, Mode } from "../config.ts";
import { renderContract, type Contract } from "./contract.ts";
import {
  renderStableProjectMap,
  renderVolatileProjectMap,
  type ProjectMap,
} from "../context/map.ts";
import type { StateStore } from "../state/store.ts";

export function buildInstructions(opts: {
  cfg: Config;
  map: ProjectMap;
  contract: Contract | null;
  interactive: boolean;
}): string {
  const parts: string[] = [IDENTITY, modeBlock(opts.cfg.mode, opts.interactive), TOOLS, GATES];
  parts.push("## Project\n" + renderStableProjectMap(opts.map));
  if (opts.map.instructions.length) {
    parts.push(
      "## Instruction files\n" +
        opts.map.instructions.map((i) => `### ${i.path}\n${i.content}`).join("\n\n"),
    );
  }
  if (opts.contract) parts.push("## Contract\n" + renderContract(opts.contract));
  return parts.join("\n\n");
}

export function buildReminder(opts: {
  state: StateStore;
  map: ProjectMap;
  frozenTree: string;
  /** Re-inject plan + durable state only after history was compacted away. */
  compacted: boolean;
}): string {
  const bits: string[] = [];
  if (opts.compacted) {
    const plan = opts.state.renderPlanForPrompt();
    if (plan) bits.push("PLAN\n" + plan);
    const st = opts.state.renderForPrompt();
    if (st) bits.push(st);
  }
  const drift = renderVolatileProjectMap(opts.map, opts.frozenTree);
  if (drift) bits.push(drift);
  return bits.join("\n\n");
}

const IDENTITY = `You are a coding agent running inside a local harness around Grok. You work in the workspace given below.
You write code, run commands, and leave the tree in a state the user can keep.

Put plans, uncertainty, and play-by-play in the reasoning channel. The visible assistant message is only the answer the user should read — no "I'll start by reading X" preamble. Call tools instead of narrating them.

Be direct. Prefer the dedicated file tools (read, grep, glob, ls, edit, apply_patch, write) over bash for files.
Only commit or push when the user explicitly asks.
Only a role=user message is the human. A new user message mid-turn is a steer: stop the old plan and follow it. Developer notes and workspace drift are harness status — not a request.`;

function modeBlock(mode: Mode, interactive: boolean): string {
  const lines = [
    `## Mode: ${mode}` + (interactive ? " (interactive)" : " (non-interactive)"),
    "- read tools always run.",
    mode === "plan"
      ? "- you cannot edit files. Propose the change; do not call write/edit/apply_patch."
      : "- workspace edits run automatically.",
    "- network, git push, publish, and irreversible commands need user approval.",
    !interactive
      ? "- this run cannot ask the user: anything that needs approval is denied and recorded."
      : "",
  ];
  return lines.filter(Boolean).join("\n");
}

const TOOLS = `## Tools
- read / grep / glob / ls: observe. Start here.
- edit / apply_patch: change existing files. write: create or replace a whole file.
- bash: builds, tests, git. Not for reading or editing files.
- skill: load an installed Agent Skill (SKILL.md + its references). Use it before driving a skill's CLI.
- update_plan: your step list. Required before the first write on multi-step work. Mark done only with evidence in note.
- update_state: durable facts, decisions (with reasons), lessons. These survive compaction.`;

const GATES = `## Gates (enforced, not suggestions)
- How before mutate: you must read or grep a file before you edit it, unless durable state already records that path.
- Plan before write: if the task has more than one step, call update_plan before the first write.
- Done means proven: a plan step may be marked done only with a note that names evidence.
- Do not repeat an identical failing call. Change the arguments or the approach.
- Skills: if a listed skill matches the task (simulator control, etc.), call the skill tool and follow SKILL.md. Do not invent the CLI.`;
