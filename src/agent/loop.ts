/**
 * The only orchestrator. boot / run / rewindTo are the product API.
 * CLI is a thin argv/TTY adapter around this file.
 */
import { loadConfig, estimateCost, type CliOverrides, type Config } from "../config.ts";
import { buildProjectMap, type ProjectMap } from "../context/map.ts";
import { Policy } from "../policy/policy.ts";
import {
  isFunctionCall,
  textOf,
  userMessage,
  developerMessage,
  type FunctionCallItem,
  type Item,
  type MessageItem,
  type Provider,
} from "../provider/types.ts";
import { XaiClient } from "../provider/xai.ts";
import { RepeatDetector } from "../recovery/classify.ts";
import { Checkpoints } from "../state/checkpoint.ts";
import { Session } from "../state/session.ts";
import { StateStore } from "../state/store.ts";
import { Trace } from "../state/trace.ts";
import {
  ALL_TOOLS,
  ToolGateway,
  type ApprovalAnswer,
  type ApprovalRequest,
  type GatewayOutcome,
} from "../tools/index.ts";
import type { ToolContext } from "../tools/types.ts";
import { compileState, draftContract } from "./ask.ts";
import { wantsContract } from "./contract.ts";
import {
  EMPTY_CURSOR,
  advancePrune,
  compactionCut,
  project,
  sealDanglingCalls,
  shouldCompact,
  truncateToTurn,
  type ContextCursor,
} from "./context.ts";
import { howBeforeMutate, noteObservation, planBeforeWrite } from "./gates.ts";
import { buildInstructions, buildReminder } from "./prompt.ts";
import { writeReceipt } from "./receipt.ts";
import { verify } from "./verify.ts";
import {
  Spinner,
  fmtUsd,
  toolLine,
  ChatUi,
  type WorkEvent,
  type ChatUiHooks,
} from "../cli/render.ts";
import type { UserImage } from "../provider/types.ts";

export interface Ui {
  user?: (text: string, images?: number) => void;
  text: (s: string) => void;
  reasoning?: (s: string) => void;
  tool: (s: string) => void;
  work?: (ev: WorkEvent) => void;
  flushWork?: () => void;
  note: (s: string) => void;
  endMessage?: () => void;
}

export const silentUi: Ui = { text() {}, tool() {}, note() {} };

export function ttyUi(hooks?: ChatUiHooks): Ui {
  const chat = new ChatUi(hooks);
  return {
    user: (t, n) => chat.user(t, n),
    text: (s) => chat.text(s),
    reasoning: (s) => chat.reasoning(s),
    tool: (s) => chat.tool(s),
    work: (ev) => chat.work(ev),
    flushWork: () => chat.flushWork(),
    note: (s) => chat.note(s),
    endMessage: () => chat.endMessage(),
  };
}

export interface Runtime {
  cwd: string;
  cfg: Config;
  session: Session;
  state: StateStore;
  checkpoints: Checkpoints;
  trace: Trace;
  gateway: ToolGateway;
  client: Provider;
  map: ProjectMap;
  interactive: boolean;
  kind: "chat" | "run";
  ui: Ui;
  signal?: AbortSignal;
  startedAt: number;
}

export interface BootOpts {
  cwd: string;
  cli?: CliOverrides;
  interactive: boolean;
  kind?: "chat" | "run";
  sessionId?: string;
  client?: Provider;
  ui?: Ui;
  askApproval?: (req: ApprovalRequest) => Promise<ApprovalAnswer>;
}

export interface RunResult {
  text: string;
  status: Session["meta"]["status"];
  costUsd: number;
  turns: number;
  receipt?: string;
  interrupted?: boolean;
}

export async function boot(opts: BootOpts): Promise<Runtime> {
  const cfg = loadConfig(opts.cwd, opts.cli ?? {});
  const session = opts.sessionId
    ? Session.load(opts.cwd, opts.sessionId)
    : Session.create(opts.cwd, cfg.model, cfg.mode);
  const trace = Trace.load(session.tracePath);
  const extras = sealDanglingCalls(session.messages).slice(session.messages.length);
  if (extras.length) {
    for (const e of extras) {
      if (e.type === "function_call_output") e.meta = { ...e.meta, turn: session.meta.turns };
    }
    session.appendAll(extras);
    trace.log({ ev: "note", text: `sealed ${extras.length} dangling tool call(s) on resume` });
  }
  const state = new StateStore(opts.cwd, session.id);
  const checkpoints = new Checkpoints(opts.cwd);
  await checkpoints.init();
  if (!session.meta.checkpoints.length) {
    const snap = await checkpoints.snapshot("start");
    if (snap) {
      session.addCheckpoint({
        sha: snap.sha,
        ts: new Date().toISOString(),
        turn: 0,
        label: "start",
        files: snap.files,
      });
      trace.log({ ev: "checkpoint", sha: snap.sha, label: "start", turn: 0, files: snap.files });
    }
  }
  const policy = new Policy(cfg, cfg.mode, opts.interactive);
  const ask =
    opts.askApproval ??
    (async (req): Promise<ApprovalAnswer> => ({
      kind: "reject",
      feedback: `non-interactive: ${req.reason}`,
    }));
  const gateway = new ToolGateway(ALL_TOOLS, policy, trace, cfg, ask);
  const client = opts.client ?? new XaiClient(cfg);
  const map = await buildProjectMap(opts.cwd, cfg.instructionFiles);
  trace.log({
    ev: "session.start",
    sessionId: session.id,
    cwd: opts.cwd,
    model: cfg.model,
    mode: cfg.mode,
    resumed: !!opts.sessionId,
  });
  trace.log({ ev: "context.loaded", sources: map.sources, chars: map.chars });
  return {
    cwd: opts.cwd,
    cfg,
    session,
    state,
    checkpoints,
    trace,
    gateway,
    client,
    map,
    interactive: opts.interactive,
    kind: opts.kind ?? (opts.interactive ? "chat" : "run"),
    ui: opts.ui ?? silentUi,
    startedAt: Date.now(),
  };
}

export type UserTurn = { text: string; images?: UserImage[] };

export async function run(
  rt: Runtime,
  task: string | UserTurn,
  opts: { signal?: AbortSignal } = {},
): Promise<RunResult> {
  const text = typeof task === "string" ? task : task.text;
  const images = typeof task === "string" ? undefined : task.images;
  rt.signal = opts.signal;
  rt.session.setStatus("active");
  const turn0 = rt.session.meta.turns;
  rt.ui.user?.(text, images?.length ?? 0);
  rt.session.append(userMessage(text, { kind: "user", turn: turn0 }, images));
  rt.trace.log({ ev: "user.message", chars: text.length, images: images?.length ?? 0 });

  if (!rt.session.meta.contract && wantsContract(rt.cfg.contract, rt.interactive)) {
    try {
      const contract = await draftContract(rt, text);
      rt.session.meta.contract = contract;
      rt.session.saveMeta();
      rt.trace.log({ ev: "contract.created", contract });
      rt.ui.note("contract: " + contract.goal);
    } catch (e) {
      rt.ui.note("contract draft failed: " + (e as Error).message);
    }
  }

  const observed = new Set<string>();
  const repeats = new RepeatDetector();
  let lastText = "";
  let verifyRound = 0;
  let filesChanged = false;
  const requirePlan =
    !rt.interactive &&
    ((rt.session.meta.contract?.doneWhen.length ?? 0) > 1 ||
      (rt.session.meta.contract?.checks.length ?? 0) > 1 ||
      rt.kind === "run");
  const effort = rt.kind === "chat" ? (rt.cfg.reasoningEffort ?? "medium") : rt.cfg.reasoningEffort;
  let instructions = buildInstructions({
    cfg: rt.cfg,
    map: rt.map,
    contract: rt.session.meta.contract,
    interactive: rt.interactive,
  });

  const deadline = Date.now() + rt.cfg.budgets.maxMinutes * 60_000;

  while (true) {
    if (opts.signal?.aborted) {
      return finishRun(rt, lastText, { interrupted: true });
    }
    if (rt.session.meta.turns - turn0 >= rt.cfg.budgets.maxTurns) {
      rt.trace.log({
        ev: "budget.exceeded",
        budget: "turns",
        value: rt.session.meta.turns - turn0,
        limit: rt.cfg.budgets.maxTurns,
      });
      rt.session.setStatus("escalated");
      lastText = lastText || "stopped: turn budget";
      break;
    }
    if (rt.session.meta.costUsd >= rt.cfg.budgets.maxCostUsd) {
      rt.trace.log({
        ev: "budget.exceeded",
        budget: "cost",
        value: rt.session.meta.costUsd,
        limit: rt.cfg.budgets.maxCostUsd,
      });
      rt.session.setStatus("escalated");
      lastText = lastText || "stopped: cost budget";
      break;
    }
    if (Date.now() > deadline) {
      rt.trace.log({
        ev: "budget.exceeded",
        budget: "minutes",
        value: (Date.now() - rt.startedAt) / 60_000,
        limit: rt.cfg.budgets.maxMinutes,
      });
      rt.session.setStatus("escalated");
      lastText = lastText || "stopped: time budget";
      break;
    }

    let cursor: ContextCursor = rt.session.meta.context ?? { ...EMPTY_CURSOR };
    const nextPrune = advancePrune(
      rt.session.messages,
      cursor,
      rt.session.meta.turns,
      rt.cfg.context,
    );
    if (nextPrune.prunedThroughTurn !== cursor.prunedThroughTurn) {
      cursor = nextPrune;
      rt.trace.log({
        ev: "context.pruned",
        removedChars: cursor.prunedChars,
        messages: rt.session.messages.length,
      });
    }
    cursor = await maybeCompact(rt, cursor, instructions.length);
    rt.session.meta.context = cursor;
    rt.session.saveMeta();

    const reminder = buildReminder({
      state: rt.state,
      costUsd: rt.session.meta.costUsd,
      maxCostUsd: rt.cfg.budgets.maxCostUsd,
      turns: rt.session.meta.turns - turn0,
      maxTurns: rt.cfg.budgets.maxTurns,
    });
    const input: Item[] = [
      ...project(rt.session.messages, cursor),
      developerMessage(reminder, { kind: "reminder" }),
    ];
    const turn = rt.session.meta.turns + 1;
    rt.trace.log({
      ev: "model.request",
      turn,
      model: rt.cfg.model,
      messages: input.length,
      approxTokens: Math.ceil((instructions.length + reminder.length) / 4),
    });

    const inflight = new Map<string, Promise<GatewayOutcome>>();
    const ctx = toolCtx(rt, turn, opts.signal);
    const spin = rt.ui === silentUi ? null : new Spinner("thinking");
    spin?.start();
    let first = true;
    const stopSpin = () => {
      if (first) {
        first = false;
        spin?.stop();
      }
    };

    let textBuf = "";
    let sawTool = false;
    let result;
    try {
      result = await rt.client.complete({
        model: rt.cfg.model,
        instructions,
        input,
        tools: rt.gateway.specs(rt.cfg.mode),
        parallelToolCalls: true,
        reasoningEffort: effort,
        cacheKey: rt.session.id,
        stream: true,
        signal: opts.signal,
        onText: (d) => {
          stopSpin();
          if (sawTool) rt.ui.reasoning?.(d);
          else textBuf += d;
        },
        onReasoning: (d) => {
          stopSpin();
          rt.ui.reasoning?.(d);
        },
        onItem: (item) => {
          if (!isFunctionCall(item)) return;
          if (!sawTool) {
            if (textBuf) rt.ui.reasoning?.(textBuf);
            textBuf = "";
            sawTool = true;
          }
          if (!rt.gateway.isParallelSafe(item)) return;
          inflight.set(item.call_id, rt.gateway.call(item, ctx));
        },
        onRetry: (attempt, reason, waitMs) => {
          rt.trace.log({ ev: "model.retry", attempt, reason, waitMs });
          rt.ui.note(`retry ${attempt}: ${reason}`);
        },
      });
    } catch (e) {
      stopSpin();
      if (isAbortError(e, opts.signal)) return finishRun(rt, lastText, { interrupted: true });
      rt.session.setStatus("failed");
      lastText = `model error: ${(e as Error).message}`;
      rt.ui.note(lastText);
      break;
    }
    stopSpin();

    const cost = estimateCost(rt.cfg, rt.cfg.model, result.usage);
    rt.session.addUsage(result.usage, cost);
    rt.session.meta.turns = turn;
    const calls = result.output.filter(isFunctionCall);
    if (calls.length) {
      if (textBuf) rt.ui.reasoning?.(textBuf);
    } else if (textBuf) {
      rt.ui.text(textBuf);
      rt.ui.endMessage?.();
    }
    const t0tools = Date.now();

    for (const item of result.output) {
      item.meta = { ...item.meta, turn };
      rt.session.append(item);
      if (item.type === "message" && item.role === "assistant") lastText = textOf(item) || lastText;
    }

    const reads = calls.filter((c) => rt.gateway.isParallelSafe(c));
    const writes = calls.filter((c) => !rt.gateway.isParallelSafe(c));
    for (const c of reads) {
      if (!inflight.has(c.call_id)) inflight.set(c.call_id, rt.gateway.call(c, ctx));
    }
    for (const c of reads) {
      const outcome = await inflight.get(c.call_id)!;
      emitTool(rt, c, outcome, turn);
      noteObservation(observed, c, outcome.result.ok);
      if (outcome.result.ok) repeats.recordSuccess(c.name, outcome.args);
      else if (repeats.recordFailure(c.name, outcome.args) >= rt.cfg.budgets.maxRepeatedFailures) {
        rt.trace.log({
          ev: "failure.repeated",
          name: c.name,
          count: rt.cfg.budgets.maxRepeatedFailures,
        });
        rt.session.setStatus("escalated");
        lastText = `repeated failure: ${c.name}`;
      }
    }
    rt.ui.flushWork?.();
    const hasPlan = rt.state.getPlan().steps.length > 0;
    for (const c of writes) {
      if (opts.signal?.aborted) return finishRun(rt, lastText, { interrupted: true });
      if (rt.session.meta.status === "escalated") break;
      const gate =
        howBeforeMutate(c, observed, rt.state) ??
        planBeforeWrite(c, {
          requirePlan,
          hasPlan: hasPlan || rt.state.getPlan().steps.length > 0,
        });
      let outcome: GatewayOutcome;
      if (gate) {
        outcome = denyGate(rt, c, gate);
      } else {
        outcome = await rt.gateway.call(c, ctx);
      }
      emitTool(rt, c, outcome, turn);
      noteObservation(observed, c, outcome.result.ok);
      if (outcome.result.changed?.length) filesChanged = true;
      if (c.name === "update_plan" && outcome.result.ok) {
        /* hasPlan is re-read from store */
      }
      if (outcome.result.ok) repeats.recordSuccess(c.name, outcome.args);
      else if (repeats.recordFailure(c.name, outcome.args) >= rt.cfg.budgets.maxRepeatedFailures) {
        rt.trace.log({
          ev: "failure.repeated",
          name: c.name,
          count: rt.cfg.budgets.maxRepeatedFailures,
        });
        rt.session.setStatus("escalated");
        lastText = `repeated failure: ${c.name}`;
      }
    }

    const toolMs = Date.now() - t0tools;
    const cachedFraction = result.usage.input_tokens
      ? result.usage.cached_tokens / result.usage.input_tokens
      : 0;
    rt.trace.log({
      ev: "model.response",
      turn,
      ms: result.ms,
      usage: result.usage,
      costUsd: cost,
      toolCalls: calls.length,
      finish: result.finishReason,
      ttftMs: result.ttftMs,
      cachedFraction,
      toolMs,
    });

    if (opts.signal?.aborted) return finishRun(rt, lastText, { interrupted: true });

    if (filesChanged) {
      rt.map = await buildProjectMap(rt.cwd, rt.cfg.instructionFiles);
      instructions = buildInstructions({
        cfg: rt.cfg,
        map: rt.map,
        contract: rt.session.meta.contract,
        interactive: rt.interactive,
      });
      const snap = await rt.checkpoints.snapshot(`turn ${turn}`);
      if (snap) {
        rt.session.addCheckpoint({
          sha: snap.sha,
          ts: new Date().toISOString(),
          turn,
          label: `turn ${turn}`,
          files: snap.files,
        });
        rt.trace.log({
          ev: "checkpoint",
          sha: snap.sha,
          label: `turn ${turn}`,
          turn,
          files: snap.files,
        });
      }
      filesChanged = false;
    }

    if (
      rt.session.meta.status === "escalated" ||
      rt.session.meta.status === "failed" ||
      rt.session.meta.status === "aborted"
    )
      break;
    if (!calls.length) {
      if (
        rt.kind === "run" &&
        rt.session.meta.checkpoints.some((c) => c.turn >= turn0 + 1) &&
        verifyRound < rt.cfg.budgets.maxVerifyRounds
      ) {
        const from =
          rt.session.meta.checkpoints.find((c) => c.turn <= turn0)?.sha ??
          rt.session.meta.checkpoints[0]?.sha;
        const diff = from ? await rt.checkpoints.diff(from) : "";
        if (diff.trim()) {
          const verdict = await verify(
            { ...rt, contract: rt.session.meta.contract },
            { diff, claim: lastText, ctx: toolCtx(rt, turn, opts.signal) },
          );
          if (verdict.verdict === "pass") break;
          verifyRound++;
          if (verifyRound >= rt.cfg.budgets.maxVerifyRounds) {
            rt.session.setStatus("escalated");
            lastText = `verifier ${verdict.verdict}: ${verdict.findings.join("; ") || "not proven"}`;
            break;
          }
          rt.session.append(
            userMessage(
              `Verifier ${verdict.verdict}. Findings:\n${verdict.findings.map((f) => `- ${f}`).join("\n")}\nFailed checks:\n${verdict.checks
                .filter((c) => !c.ok)
                .map((c) => `- ${c.name}: ${c.tail.slice(0, 400)}`)
                .join("\n")}\nRepair and prove it.`,
              { kind: "verify", turn },
            ),
          );
          continue;
        }
      }
      break;
    }
  }

  return finishRun(rt, lastText);
}

function isAbortError(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (e && typeof e === "object" && "name" in e && (e as { name: string }).name === "AbortError")
    return true;
  const m = e instanceof Error ? e.message : String(e);
  return /aborted|AbortError/i.test(m);
}

function finishRun(
  rt: Runtime,
  lastText: string,
  extra: { interrupted?: boolean } = {},
): RunResult {
  const extras = sealDanglingCalls(rt.session.messages).slice(rt.session.messages.length);
  if (extras.length) rt.session.appendAll(extras);
  if (extra.interrupted) {
    rt.session.setStatus("active");
    rt.trace.log({ ev: "note", text: "interrupted by user; waiting for steer" });
    rt.ui.note("interrupted — send another message to steer");
  } else if (rt.session.meta.status === "active") {
    rt.session.setStatus("completed");
  }
  rt.ui.endMessage?.();
  const receipt = writeReceipt(rt.session, rt.trace);
  if (!extra.interrupted) {
    rt.trace.log({
      ev: "session.end",
      reason: rt.session.meta.status,
      turns: rt.session.meta.turns,
      costUsd: rt.session.meta.costUsd,
    });
    rt.ui.note(
      `${fmtUsd(rt.session.meta.costUsd)}  ${rt.session.meta.turns} turns  ${Math.round((rt.session.meta.usage.input_tokens ? rt.session.meta.usage.cached_tokens / rt.session.meta.usage.input_tokens : 0) * 100)}% cached`,
    );
  }
  return {
    text: lastText,
    status: rt.session.meta.status,
    costUsd: rt.session.meta.costUsd,
    turns: rt.session.meta.turns,
    receipt,
    interrupted: extra.interrupted,
  };
}

export async function rewindTo(rt: Runtime, sha: string): Promise<void> {
  const cp = rt.session.meta.checkpoints.find(
    (c) => c.sha === sha || sha.startsWith(c.sha) || c.sha.startsWith(sha),
  );
  if (!cp) throw new Error(`no checkpoint ${sha}`);
  await rt.checkpoints.rewind(cp.sha);
  const kept = truncateToTurn(rt.session.messages, cp.turn);
  rt.session.replaceMessages(kept, `rewind to ${cp.sha}`);
  rt.session.meta.turns = cp.turn;
  rt.session.meta.status = "active";
  rt.session.saveMeta();
  rt.trace.log({ ev: "rewind", sha: cp.sha });
}

async function maybeCompact(
  rt: Runtime,
  cursor: ContextCursor,
  extraChars: number,
): Promise<ContextCursor> {
  if (!shouldCompact(rt.session.messages, extraChars, rt.cfg.context, cursor)) return cursor;
  const before = Math.ceil(JSON.stringify(project(rt.session.messages, cursor)).length / 4);
  await compileState(rt, project(rt.session.messages, cursor).slice(-40));
  if (!rt.client.compact) return cursor;
  try {
    const cut = compactionCut(rt.session.messages, cursor, 8);
    const r = await rt.client.compact(project(rt.session.messages, cursor), {
      model: rt.cfg.helperModel,
      signal: rt.signal,
    });
    const cost = estimateCost(rt.cfg, rt.cfg.helperModel, r.usage);
    rt.session.addUsage(r.usage, cost);
    const summary: MessageItem =
      (r.output.find((i): i is MessageItem => i.type === "message") as MessageItem | undefined) ??
      userMessage("Prior turns compacted. Continue from durable state and the original task.", {
        kind: "summary",
      });
    summary.meta = { ...summary.meta, kind: "summary" };
    const next: ContextCursor = {
      ...cursor,
      compactedThroughTurn: cut,
      summary,
      compactions: cursor.compactions + 1,
    };
    const after = Math.ceil(JSON.stringify(project(rt.session.messages, next)).length / 4);
    rt.trace.log({ ev: "context.compacted", beforeTokens: before, afterTokens: after });
    return next;
  } catch (e) {
    rt.ui.note("compact failed: " + (e as Error).message);
    return cursor;
  }
}

function toolCtx(rt: Runtime, turn: number, signal?: AbortSignal): ToolContext {
  return {
    cwd: rt.cwd,
    config: rt.cfg,
    trace: rt.trace,
    state: rt.state,
    sessionId: rt.session.id,
    turn,
    sandboxed: false,
    signal,
  };
}

function emitTool(rt: Runtime, call: FunctionCallItem, outcome: GatewayOutcome, turn: number) {
  const status =
    !outcome.result.ok && outcome.decision.action === "deny"
      ? "denied"
      : outcome.result.ok
        ? "ok"
        : "fail";
  const args =
    outcome.args && typeof outcome.args === "object"
      ? (outcome.args as Record<string, unknown>)
      : undefined;
  if (rt.ui.work) {
    rt.ui.work({
      name: call.name,
      summary: outcome.result.summary ?? call.name,
      status,
      args,
      output: outcome.result.output,
      changed: outcome.result.changed,
    });
  } else {
    rt.ui.tool(toolLine(call.name, outcome.result.summary ?? call.name, status));
  }
  rt.session.append({
    type: "function_call_output",
    call_id: call.call_id,
    output: outcome.result.output,
    meta: { turn, chars: outcome.result.output.length },
  });
}

function denyGate(rt: Runtime, call: FunctionCallItem, reason: string): GatewayOutcome {
  rt.trace.log({ ev: "policy.blocked", name: call.name, reason });
  rt.trace.log({
    ev: "tool.decision",
    id: call.call_id,
    name: call.name,
    decision: "deny",
    reason,
  });
  return {
    result: {
      ok: false,
      output: `blocked by policy: ${reason}`,
      failureClass: "permission_denied",
      summary: reason,
    },
    decision: { action: "deny", reason },
    risk: "reversible",
    ms: 0,
    args: {},
  };
}
