/**
 * Interactive chat REPL. Type another message while the agent is working to
 * interrupt it and steer. Paste a screenshot (empty paste reads the clipboard
 * on macOS; image file paths and iTerm OSC 1337 also work). Ctrl-C interrupts;
 * twice while idle quits.
 */
import { boot, run, rewindTo, ttyUi, type Runtime } from "../agent/loop.ts";
import { fmtUsd, c, line, err } from "./render.ts";
import { LineEditor, readPlainLine, type TurnInput } from "./input.ts";
import type { CliOverrides } from "../config.ts";
import { askApproval } from "./approve.ts";

export async function repl(opts: {
  cwd: string;
  cli: CliOverrides;
  sessionId?: string;
  first?: string;
}) {
  const ctl: { abort: AbortController | null; busy: boolean } = { abort: null, busy: false };
  let pendingSteer: TurnInput | undefined;
  let lastIdleSigint = 0;
  const editor = new LineEditor();

  const rt: Runtime = await boot({
    cwd: opts.cwd,
    cli: opts.cli,
    interactive: true,
    kind: "chat",
    sessionId: opts.sessionId,
    ui: ttyUi({
      before: () => editor.hide(),
      after: () => editor.redraw(),
    }),
    askApproval,
  });
  line(c.dim(`session ${rt.session.id}  ${rt.cfg.model}  mode ${rt.cfg.mode}`));
  line(c.dim("type to steer while it works · paste an image · /think /cost /rewind /quit"));

  const tty = !!process.stdin.isTTY;
  if (tty) editor.start();

  const handle = async (turn: TurnInput) => {
    const text = turn.text.trim();
    if (!text && !turn.images.length) {
      editor.redraw();
      return;
    }
    if (text === "/quit" || text === "/exit") {
      editor.stop();
      line(c.dim("bye"));
      process.exit(0);
    }
    if (applyMetaSlash(rt, text, editor)) return;
    if (text.startsWith("/rewind")) {
      const sha = text.slice(7).trim() || rt.session.meta.checkpoints.at(-1)?.sha;
      if (!sha) {
        err("no checkpoints");
        editor.redraw();
        return;
      }
      try {
        await rewindTo(rt, sha);
        line(c.yellow(`rewound to ${sha}`));
      } catch (e) {
        err((e as Error).message);
      }
      editor.redraw();
      return;
    }

    ctl.busy = true;
    editor.setBusy(true);
    ctl.abort = new AbortController();
    try {
      await run(rt, { text, images: turn.images }, { signal: ctl.abort.signal });
      process.stdout.write("\n");
    } catch (e) {
      err((e as Error).message);
    } finally {
      ctl.busy = false;
      ctl.abort = null;
      editor.setBusy(false);
      const next = pendingSteer;
      pendingSteer = undefined;
      if (next) await handle(next);
      else editor.redraw();
    }
  };

  const onTurn = (t: TurnInput) => {
    if (ctl.busy) {
      const text = t.text.trim();
      if (text === "/quit" || text === "/exit") {
        ctl.abort?.abort();
        editor.stop();
        line(c.dim("bye"));
        process.exit(0);
      }
      if (applyMetaSlash(rt, text, editor)) return;
      if (!text && !t.images.length) return;
      pendingSteer = t;
      line(c.yellow("steering…"));
      ctl.abort?.abort();
      return;
    }
    void handle(t);
  };

  if (!tty) {
    if (opts.first) await handle({ text: opts.first, images: [] });
    for (;;) {
      const r = await readPlainLine();
      if ("eof" in r) break;
      await handle(r);
    }
    line(c.dim("bye"));
    process.exit(0);
  }

  if (opts.first) void handle({ text: opts.first, images: [] });

  for (;;) {
    const r = await editor.line();
    if ("eof" in r) {
      editor.stop();
      line(c.dim("bye"));
      process.exit(0);
    }
    if ("interrupt" in r) {
      if (ctl.busy) {
        ctl.abort?.abort();
        line(c.yellow("interrupted"));
        continue;
      }
      const now = Date.now();
      if (now - lastIdleSigint < 1500) {
        editor.stop();
        line(c.dim("bye"));
        process.exit(0);
      }
      lastIdleSigint = now;
      line(c.dim("Ctrl-C again to quit"));
      editor.redraw();
      continue;
    }
    onTurn(r);
  }
}

/** /cost and /think do not abort the in-flight turn. */
function applyMetaSlash(rt: Runtime, text: string, editor: LineEditor): boolean {
  if (text === "/cost") {
    line(
      `${fmtUsd(rt.session.meta.costUsd)}  ${rt.session.meta.turns} turns  ${rt.session.meta.usage.cached_tokens} cached tokens`,
    );
    editor.redraw();
    return true;
  }
  if (text === "/think" || text.startsWith("/think ")) {
    const arg = text.slice("/think".length).trim().toLowerCase();
    const current = rt.session.meta.showReasoning ?? false;
    const on = arg === "on" ? true : arg === "off" ? false : !current;
    rt.session.meta.showReasoning = on;
    rt.session.saveMeta();
    rt.ui.setShowReasoning?.(on);
    line(c.dim(on ? "reasoning on" : "reasoning hidden · /think to peek"));
    editor.redraw();
    return true;
  }
  return false;
}
