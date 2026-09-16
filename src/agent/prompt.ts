/**
 * Prompt assembly. Two layers so the prefix cache stays warm:
 *
 *   instructions  stable for the session: identity, mode, map, contract, instruction files
 *   reminder      trailing, ephemeral, not persisted: plan, durable state, remaining budget
 *
 * Editing the middle of history is a speed bug. The reminder is appended only
 * to the projected input for this request.
 */
import type { Config, Mode } from "../config.ts";
import { renderContract, type Contract } from "./contract.ts";
import { renderProjectMap, type ProjectMap } from "../context/map.ts";
import type { StateStore } from "../state/store.ts";
import { fmtUsd } from "../cli/render.ts";

export function buildInstructions(opts: {
  cfg: Config;
  map: ProjectMap;
  contract: Contract | null;
  interactive: boolean;
}): string {
  const parts: string[] = [IDENTITY, modeBlock(opts.cfg.mode, opts.interactive), TOOLS, GATES];
  parts.push("## Project\n" + renderProjectMap(opts.map));
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
  costUsd: number;
  maxCostUsd: number;
  turns: number;
  maxTurns: number;
}): string {
  const bits: string[] = [];
  const plan = opts.state.renderPlanForPrompt();
  if (plan) bits.push("PLAN\n" + plan);
  const st = opts.state.renderForPrompt();
  if (st) bits.push(st);
  bits.push(
    `HARNESS STATUS (not the user)  ${fmtUsd(opts.costUsd)} of ${fmtUsd(opts.maxCostUsd)} spent, turn ${opts.turns}/${opts.maxTurns}.`,
  );
  return bits.join("\n\n");
}

const IDENTITY = `You are a coding agent running inside a local harness around Grok. You work in the workspace given below.
You write code, run commands, and leave the tree in a state the user can keep.

Put plans, uncertainty, and play-by-play in the reasoning channel. The visible assistant message is only the answer the user should read — no "I'll start by reading X" preamble. Call tools instead of narrating them.

Be direct. Prefer the dedicated file tools (read, grep, glob, ls, edit, apply_patch, write) over bash for files.
Only commit or push when the user explicitly asks.
The user may interrupt a turn and send a new message. Treat that as a steer: stop the old plan and follow the new instruction.
A trailing developer message is harness status (plan, budget). It is not the user and is not a steer.`;

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
