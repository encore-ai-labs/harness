/**
 * Session persistence.
 *
 * A session is one directory: .harness/sessions/<id>/
 *   meta.json       id, cwd, model, contract, usage totals, status, checkpoints
 *   messages.jsonl  every message in order (append-only; cheap for long runs)
 *   trace.jsonl     the run trace (see state/trace.ts)
 *
 * Why a directory of append-only files: long-horizon sessions can have
 * thousands of messages. Rewriting one big JSON after every tool result is
 * O(n²) and loses data if the process dies mid-write. Appending a line is
 * atomic enough and lets `resume` replay exactly what happened.
 *
 * Message shape follows the xAI Responses item list. A harness-only `meta`
 * field is stripped before sending to the model.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Item, type Usage, ZERO_USAGE, isMessage, textOf } from "../provider/types.ts";
import type { Contract } from "../agent/contract.ts";
import type { ContextCursor } from "../agent/context.ts";
import type { RepeatSnapshot } from "../recovery/classify.ts";

export interface Checkpoint {
  sha: string;
  ts: string;
  turn: number;
  label: string;
  files: number;
}

export interface SessionMeta {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  mode: string;
  status: "active" | "completed" | "escalated" | "failed" | "aborted";
  contract: Contract | null;
  usage: Usage;
  costUsd: number;
  turns: number;
  checkpoints: Checkpoint[];
  /** Short human description (first user message) for `harness sessions`. */
  title: string;
  context?: ContextCursor;
  /** Paths observed this session (how-before-mutate). Survives chat turns and resume. */
  observed?: string[];
  /** Repeat detector snapshot. Survives chat turns and resume. */
  repeats?: RepeatSnapshot;
  /** When true, stream reasoning to the TTY instead of hiding it behind the spinner. */
  showReasoning?: boolean;
}

export function newSessionId(): string {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

export class Session {
  readonly dir: string;
  meta: SessionMeta;
  messages: Item[] = [];

  private constructor(
    readonly cwd: string,
    meta: SessionMeta,
  ) {
    this.dir = join(cwd, ".harness", "sessions", meta.id);
    this.meta = meta;
  }

  static create(cwd: string, model: string, mode: string): Session {
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id: newSessionId(),
      cwd,
      createdAt: now,
      updatedAt: now,
      model,
      mode,
      status: "active",
      contract: null,
      usage: { ...ZERO_USAGE },
      costUsd: 0,
      turns: 0,
      checkpoints: [],
      title: "",
    };
    const s = new Session(cwd, meta);
    mkdirSync(s.dir, { recursive: true });
    s.saveMeta();
    writeFileSync(join(s.dir, "messages.jsonl"), "");
    return s;
  }

  static load(cwd: string, id: string): Session {
    const dir = join(cwd, ".harness", "sessions", id);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as SessionMeta;
    const s = new Session(cwd, meta);
    const raw = readFileSync(join(dir, "messages.jsonl"), "utf8");
    s.messages = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Item);
    return s;
  }

  static list(cwd: string): SessionMeta[] {
    const root = join(cwd, ".harness", "sessions");
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((d) => existsSync(join(root, d, "meta.json")))
      .map((d) => JSON.parse(readFileSync(join(root, d, "meta.json"), "utf8")) as SessionMeta)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  static latest(cwd: string): SessionMeta | null {
    return Session.list(cwd)[0] ?? null;
  }

  get id(): string {
    return this.meta.id;
  }

  get tracePath(): string {
    return join(this.dir, "trace.jsonl");
  }

  append(msg: Item) {
    this.messages.push(msg);
    appendFileSync(join(this.dir, "messages.jsonl"), JSON.stringify(msg) + "\n");
    if (!this.meta.title && isMessage(msg) && msg.role === "user") {
      this.meta.title = textOf(msg).slice(0, 80).replace(/\s+/g, " ");
    }
    this.touch();
  }

  appendAll(msgs: Item[]) {
    for (const m of msgs) this.append(m);
  }

  /**
   * Replace the whole message list (after compaction / pruning). We rewrite the
   * file and keep the old one as messages.<n>.jsonl so nothing is ever lost.
   */
  replaceMessages(msgs: Item[], reason: string) {
    const gen = readdirSync(this.dir).filter((f) => /^messages\.\d+\.jsonl$/.test(f)).length + 1;
    const old = join(this.dir, "messages.jsonl");
    if (existsSync(old) && statSync(old).size > 0) {
      writeFileSync(join(this.dir, `messages.${gen}.jsonl`), readFileSync(old));
    }
    this.messages = msgs;
    writeFileSync(old, msgs.map((m) => JSON.stringify(m)).join("\n") + (msgs.length ? "\n" : ""));
    appendFileSync(
      join(this.dir, "events.log"),
      `${new Date().toISOString()} replaceMessages: ${reason}\n`,
    );
    this.touch();
  }

  addUsage(u: Usage, costUsd: number) {
    const t = this.meta.usage;
    t.input_tokens += u.input_tokens;
    t.output_tokens += u.output_tokens;
    t.total_tokens += u.total_tokens;
    t.cached_tokens += u.cached_tokens;
    t.reasoning_tokens += u.reasoning_tokens;
    this.meta.costUsd += costUsd;
    this.touch();
  }

  addCheckpoint(cp: Checkpoint) {
    this.meta.checkpoints.push(cp);
    this.saveMeta();
  }

  setStatus(s: SessionMeta["status"]) {
    this.meta.status = s;
    this.saveMeta();
  }

  touch() {
    this.meta.updatedAt = new Date().toISOString();
    this.saveMeta();
  }

  saveMeta() {
    writeFileSync(join(this.dir, "meta.json"), JSON.stringify(this.meta, null, 2) + "\n");
  }
}
