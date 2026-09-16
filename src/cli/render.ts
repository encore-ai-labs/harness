/**
 * Terminal rendering. Cursor-CLI shaped: boxed user turn, readable thoughts,
 * grouped tool work, green edit previews. Trace still records every call.
 */
import {
  addedLines,
  isObserve,
  observeHeadline,
  observeTail,
  toolTitle,
  userBanner,
  workPath,
  type WorkEvent,
} from "./work.ts";

export type { WorkEvent, WorkStatus } from "./work.ts";
export { isObserve, observeHeadline, toolTitle, workPath, userBanner } from "./work.ts";

const isTTY = process.stdout.isTTY ?? false;
const NO_COLOR = !!process.env.NO_COLOR || !isTTY;

function wrap(open: number, close: number) {
  return (s: string) => (NO_COLOR ? s : `\x1b[${open}m${s}\x1b[${close}m`);
}

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export const out = (s = "") => process.stdout.write(s);
export const line = (s = "") => process.stdout.write(s + "\n");
export const err = (s = "") => process.stderr.write(s + "\n");

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + "…";
}

export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Render a tool call as a single line: ⚙ name  summary */
export function toolLine(
  name: string,
  summary: string,
  status: "run" | "ok" | "fail" | "denied" | "ask" = "run",
): string {
  const icon =
    status === "ok"
      ? c.green("✓")
      : status === "fail"
        ? c.red("✗")
        : status === "denied"
          ? c.yellow("⊘")
          : status === "ask"
            ? c.yellow("?")
            : c.cyan("⚙");
  return `${icon} ${c.bold(name)}  ${c.dim(truncate(oneLine(summary), 110))}`;
}

export function box(title: string, body: string, color: (s: string) => string = c.cyan): string {
  const width = Math.min(process.stdout.columns ?? 100, 100);
  const top = color(`┌─ ${title} ${"─".repeat(Math.max(0, width - title.length - 4))}`);
  const lines = body.split("\n").map((l) => color("│ ") + l);
  const bottom = color("└" + "─".repeat(width - 1));
  return [top, ...lines, bottom].join("\n");
}

/**
 * Markdown-lite for streamed assistant text. We only handle what matters in a
 * terminal: headers, bold, inline code, fenced code. Anything fancier is noise.
 */
export class MarkdownStream {
  private inFence = false;
  private buf = "";

  /** Feed a chunk; returns text to print now (we only render complete lines). */
  push(chunk: string): string {
    this.buf += chunk;
    let outText = "";
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      outText += this.renderLine(raw) + "\n";
    }
    return outText;
  }

  /** Flush whatever is left (end of message). */
  flush(): string {
    if (!this.buf) return "";
    const s = this.renderLine(this.buf) + "\n";
    this.buf = "";
    return s;
  }

  private renderLine(l: string): string {
    if (l.trimStart().startsWith("```")) {
      this.inFence = !this.inFence;
      return c.gray(l);
    }
    if (this.inFence) return c.gray("  " + l);
    let s = l;
    const h = /^(#{1,6})\s+(.*)$/.exec(s);
    if (h) return c.bold(c.magenta(h[2] ?? ""));
    s = s.replace(/\*\*(.+?)\*\*/g, (_, m) => c.bold(m));
    s = s.replace(/`([^`]+)`/g, (_, m) => c.cyan(m));
    s = s.replace(/^(\s*)[-*]\s+/, (_, sp) => `${sp}• `);
    return s;
  }
}

export interface ChatUiHooks {
  /** Erase the input line before we write so the prompt stays at the bottom. */
  before?: () => void;
  after?: () => void;
}

const THINK_LABELS = [
  "just choding…",
  "choding around…",
  "thinking",
  "choding on it",
  "poking around",
  "still choding",
  "tracing it",
  "holding the thought",
  "choding through it",
  "chewing on it",
  "mapping it",
  "choding quietly",
  "turning it over",
  "following the thread",
];

export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private i = 0;
  private labelIdx = Math.floor(Math.random() * THINK_LABELS.length);
  private ticks = 0;
  private suffix = "";
  constructor(
    private label = THINK_LABELS[0]!,
    private hooks: ChatUiHooks = {},
  ) {}
  start() {
    if (!isTTY || this.timer) return;
    this.i = 0;
    this.ticks = 0;
    this.timer = setInterval(() => {
      this.ticks++;
      if (this.ticks % 25 === 0) this.labelIdx = (this.labelIdx + 1) % THINK_LABELS.length;
      this.paint();
    }, 80);
    this.paint();
  }
  setSuffix(s: string) {
    this.suffix = s;
  }
  update(label: string) {
    this.label = label;
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (isTTY) {
      this.hooks.before?.();
      out("\r\x1b[2K");
      this.hooks.after?.();
    }
  }
  private paint() {
    const f = this.frames[this.i++ % this.frames.length];
    const mood = THINK_LABELS[this.labelIdx] ?? this.label;
    const extra = this.suffix ? `  ${c.dim(this.suffix)}` : "";
    this.hooks.before?.();
    out(`\r${c.cyan(f ?? "")} ${c.dim(mood)}${extra}\x1b[K`);
    this.hooks.after?.();
  }
}

export function fmtUsd(n: number): string {
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * Cursor-CLI layout: boxed user turn, spinner (or dim thoughts when /think),
 * grouped work, green edit previews, markdown answer.
 */
export class ChatUi {
  private thinking = false;
  private thinkCol = 0;
  private md = new MarkdownStream();
  private answering = false;
  private observe: WorkEvent[] = [];
  private showThink: boolean;
  private thoughtLog = "";
  private spin: Spinner;

  constructor(
    private hooks: ChatUiHooks = {},
    opts: { showReasoning?: boolean } = {},
  ) {
    this.showThink = !!opts.showReasoning;
    this.spin = new Spinner("thinking", hooks);
  }

  beginTurn(chrome?: { budget?: string }) {
    this.thoughtLog = "";
    this.spin.setSuffix(chrome?.budget ?? "");
    if (!this.showThink) this.spin.start();
  }

  setShowReasoning(on: boolean) {
    this.showThink = on;
    if (on) {
      this.spin.stop();
      if (this.thoughtLog) {
        this.flushWork();
        this.openThinking();
        this.writeThinking(this.thoughtLog);
        this.hooks.after?.();
      }
    } else {
      this.closeThinking();
    }
  }

  showingReasoning(): boolean {
    return this.showThink;
  }

  user(text: string, images = 0) {
    this.spin.stop();
    this.flushWork();
    this.closeThinking();
    this.emit(userBanner(text, images, process.stdout.columns ?? 80) + "\n\n");
  }

  reasoning(s: string) {
    this.thoughtLog += s;
    if (!this.showThink) return;
    this.spin.stop();
    this.flushWork();
    this.openThinking();
    this.writeThinking(s);
    this.hooks.after?.();
  }

  text(s: string) {
    this.spin.stop();
    this.flushWork();
    this.closeThinking();
    if (!this.answering) {
      this.emit("\n");
      this.answering = true;
    }
    this.emit(this.md.push(s));
    this.hooks.after?.();
  }

  tool(s: string) {
    this.spin.stop();
    this.flushWork();
    this.closeThinking();
    this.emit(s + "\n");
  }

  work(ev: WorkEvent) {
    this.spin.stop();
    this.closeThinking();
    if (isObserve(ev.name) && ev.status !== "fail" && ev.status !== "denied") {
      this.observe.push(ev);
      return;
    }
    this.flushWork();
    this.emit(formatWorkEvent(ev) + "\n\n");
  }

  flushWork() {
    if (!this.observe.length) return;
    this.spin.stop();
    this.emit(formatObserveGroup(this.observe) + "\n\n");
    this.observe = [];
  }

  note(s: string) {
    this.spin.stop();
    this.flushWork();
    this.closeThinking();
    this.emit(c.gray(s) + "\n");
  }

  endMessage() {
    this.spin.stop();
    this.flushWork();
    if (this.answering) this.emit(this.md.flush());
    this.closeThinking();
    this.md = new MarkdownStream();
    this.answering = false;
    this.hooks.after?.();
  }

  private emit(s: string) {
    if (!s) return;
    this.hooks.before?.();
    out(s);
    this.hooks.after?.();
  }

  private openThinking() {
    if (this.thinking) return;
    this.thinking = true;
    this.thinkCol = 0;
  }

  private closeThinking() {
    if (!this.thinking) return;
    if (this.thinkCol > 0) this.emit("\n");
    this.thinking = false;
    this.thinkCol = 0;
    this.emit("\n");
  }

  private writeThinking(s: string) {
    const width = Math.max(40, (process.stdout.columns ?? 80) - 2);
    this.hooks.before?.();
    for (const ch of s) {
      if (ch === "\n") {
        out("\n");
        this.thinkCol = 0;
        continue;
      }
      if (this.thinkCol >= width && ch === " ") {
        out("\n");
        this.thinkCol = 0;
        continue;
      }
      if (this.thinkCol >= width) {
        out("\n");
        this.thinkCol = 0;
      }
      out(c.dim(ch));
      this.thinkCol++;
    }
    this.hooks.after?.();
  }
}

export function formatObserveGroup(events: WorkEvent[]): string {
  const lines = [c.bold(observeHeadline(events))];
  const { hidden, tail } = observeTail(events);
  if (hidden) lines.push(c.gray(`… ${hidden} earlier item${hidden === 1 ? "" : "s"} hidden`));
  for (const e of tail) {
    const a = e.args ?? {};
    let extra = "";
    if (e.name === "read" && (a.offset || a.limit)) {
      const start = Number(a.offset ?? 1);
      const n = Number(a.limit ?? 0);
      extra = n ? c.dim(` lines ${start}–${start + n - 1}`) : c.dim(` line ${start}+`);
    }
    lines.push(
      `${c.bold(toolTitle(e.name))} ${c.dim(truncate(oneLine(workPath(e)), 100))}${extra}`,
    );
  }
  return lines.join("\n");
}

export function formatWorkEvent(ev: WorkEvent): string {
  if (ev.name === "edit" || ev.name === "write" || ev.name === "apply_patch") {
    const { path, plus, lines, hidden } = addedLines(ev);
    const fail = ev.status === "fail" || ev.status === "denied";
    const head = fail
      ? `${c.red("✗")} ${c.bold("Edited")} ${path}  ${c.dim(ev.summary)}`
      : `${c.bold("Edited")} ${path} ${c.green(`+${plus}`)}`;
    if (fail || !lines.length) return head;
    const preview = lines.map((l) => c.green(`+ ${l}`)).join("\n");
    const more = hidden ? `\n${c.gray(`… truncated (${hidden} more lines)`)}` : "";
    return `${head}\n${preview}${more}`;
  }
  const fail = ev.status === "fail" || ev.status === "denied";
  const mark = fail ? `${c.red("✗")} ` : ev.status === "ask" ? `${c.yellow("?")} ` : "";
  const lines = [
    `${mark}${c.bold(toolTitle(ev.name))} ${c.dim(truncate(oneLine(workPath(ev)), 110))}`,
  ];
  if (ev.name === "bash" && ev.output) {
    const tail = ev.output.trim().split("\n").slice(-4).join("\n");
    if (tail) lines.push(c.gray(truncate(tail, 400)));
  } else if (ev.output && (ev.name === "skill" || fail)) {
    const first = ev.output.trim().split("\n")[0];
    if (first) lines.push(c.gray(truncate(first, 160)));
  }
  return lines.join("\n");
}
