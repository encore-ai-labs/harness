#!/usr/bin/env bun
/**
 * CLI entry. sessions / show / rewind do not open a model client.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, HELP } from "./cli/args.ts";
import { err, line, c, fmtUsd } from "./cli/render.ts";
import { Session } from "./state/session.ts";
import { boot, run, rewindTo, ttyUi } from "./agent/loop.ts";
import { askApproval } from "./cli/approve.ts";
import { repl } from "./cli/repl.ts";
import { discoverSkills } from "./skills/discover.ts";
import { installSkill, removeSkill } from "./skills/install.ts";

const cwd = process.cwd();

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    err((e as Error).message);
    process.exit(2);
    return;
  }
  if (args.command === "help") {
    line(HELP);
    return;
  }
  const cli = args.flags;

  if (args.command === "sessions") {
    const list = Session.list(cwd);
    if (!list.length) {
      line("no sessions");
      return;
    }
    for (const s of list) {
      line(
        `${c.bold(s.id)}  ${s.status}  ${fmtUsd(s.costUsd)}  ${s.turns}t  ${s.title || "(untitled)"}`,
      );
    }
    return;
  }

  if (args.command === "show") {
    const id = args.positional[0] ?? Session.latest(cwd)?.id;
    if (!id) {
      err("no sessions");
      process.exit(1);
    }
    const s = Session.load(cwd, id);
    if (args.flags.receipt) {
      const p = join(s.dir, "receipt.md");
      if (!existsSync(p)) {
        err("no receipt.md yet");
        process.exit(1);
      }
      line(readFileSync(p, "utf8"));
      return;
    }
    if (args.flags.trace) {
      const p = s.tracePath;
      if (!existsSync(p)) {
        err("no trace.jsonl");
        process.exit(1);
      }
      line(readFileSync(p, "utf8"));
      return;
    }
    line(JSON.stringify(s.meta, null, 2));
    return;
  }

  if (args.command === "rewind") {
    const sha = args.positional[0];
    if (!sha) {
      err("usage: harness rewind <sha>");
      process.exit(2);
    }
    const latest = Session.latest(cwd);
    if (!latest) {
      err("no sessions");
      process.exit(1);
    }
    const rt = await boot({
      cwd,
      cli,
      interactive: true,
      sessionId: latest.id,
      ui: ttyUi(),
      askApproval,
    });
    await rewindTo(rt, sha);
    line(c.yellow(`rewound ${latest.id} to ${sha}`));
    return;
  }

  if (args.command === "skill") {
    const sub = args.positional[0] ?? "list";
    if (sub === "list") {
      const skills = discoverSkills(cwd);
      if (!skills.length) {
        line("no skills. install: harness skill add EvanBacon/serve-sim");
        return;
      }
      for (const s of skills) {
        line(`${c.bold(s.name)}  [${s.scope}]  ${s.description}`);
        line(c.dim(`  ${s.dir}`));
      }
      return;
    }
    if (sub === "add") {
      const source = args.positional[1];
      if (!source) {
        err("usage: harness skill add <github-or-path> [--project] [--force]");
        process.exit(2);
        return;
      }
      try {
        const installed = await installSkill(source, {
          cwd,
          project: args.flags.project,
          force: args.flags.force,
        });
        for (const s of installed) line(`installed ${c.bold(s.name)} → ${s.dir}`);
      } catch (e) {
        err((e as Error).message);
        process.exit(1);
      }
      return;
    }
    if (sub === "remove" || sub === "rm") {
      const name = args.positional[1];
      if (!name) {
        err("usage: harness skill remove <name> [--project]");
        process.exit(2);
        return;
      }
      try {
        const dir = removeSkill(name, { cwd, project: args.flags.project });
        line(`removed ${dir}`);
      } catch (e) {
        err((e as Error).message);
        process.exit(1);
      }
      return;
    }
    err(`unknown skill subcommand ${sub} (list|add|remove)`);
    process.exit(2);
    return;
  }

  if (args.command === "resume") {
    const id = args.positional[0] ?? Session.latest(cwd)?.id;
    if (!id) {
      err("no sessions to resume");
      process.exit(1);
    }
    await repl({ cwd, cli, sessionId: id, first: args.positional.slice(1).join(" ") || undefined });
    return;
  }

  if (args.command === "run") {
    const task = args.positional.join(" ").trim();
    if (!task) {
      err('usage: harness run "<task>"');
      process.exit(2);
    }
    const rt = await boot({ cwd, cli, interactive: false, kind: "run", ui: ttyUi(), askApproval });
    const result = await run(rt, task);
    process.stdout.write("\n");
    line(c.dim(`${result.status}  ${fmtUsd(result.costUsd)}  ${result.turns} turns`));
    process.exit(result.status === "completed" ? 0 : 1);
  }

  // chat
  const first = args.positional.join(" ").trim() || undefined;
  await repl({ cwd, cli, first });
}

main().catch((e) => {
  err(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
