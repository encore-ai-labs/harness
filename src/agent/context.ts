import type { Item, MessageItem, FunctionCallOutputItem } from "../provider/types.ts";
import { approxTokens, isFunctionCall, isFunctionOutput } from "../provider/types.ts";
import type { Config } from "../config.ts";

export interface ContextCursor {
  compactedThroughTurn: number;
  summary: MessageItem | null;
  prunedThroughTurn: number;
  compactions: number;
  prunedChars: number;
}

export const EMPTY_CURSOR: ContextCursor = {
  compactedThroughTurn: -1,
  summary: null,
  prunedThroughTurn: -1,
  compactions: 0,
  prunedChars: 0,
};

function turnOf(i: Item): number {
  return (i as { meta?: { turn?: number } }).meta?.turn ?? 0;
}

export function project(items: readonly Item[], cursor: ContextCursor): Item[] {
  const out: Item[] = [];
  if (cursor.summary && cursor.compactedThroughTurn >= 0) out.push(cursor.summary);
  for (const i of items) {
    const t = turnOf(i);
    if (t <= cursor.compactedThroughTurn) continue;
    if (
      i.type === "function_call_output" &&
      t <= cursor.prunedThroughTurn &&
      !(i as FunctionCallOutputItem).meta?.pruned
    ) {
      const orig = i as FunctionCallOutputItem;
      const chars = orig.meta?.chars ?? orig.output.length;
      out.push({
        ...orig,
        output: `[pruned: ${chars} chars from turn ${t}. Re-read or grep if you still need it.]`,
        meta: { ...orig.meta, pruned: true, chars },
      });
      continue;
    }
    out.push(i);
  }
  return out;
}

export function advancePrune(
  items: readonly Item[],
  cursor: ContextCursor,
  turn: number,
  cfg: Config["context"],
): ContextCursor {
  const cutoff = turn - cfg.pruneAfterTurns;
  if (cutoff <= cursor.prunedThroughTurn) return cursor;
  let reclaim = 0;
  let n = 0;
  for (const i of items) {
    if (i.type !== "function_call_output") continue;
    const t = turnOf(i);
    if (t <= cursor.prunedThroughTurn || t > cutoff) continue;
    if ((i as FunctionCallOutputItem).meta?.pruned) continue;
    reclaim += (i as FunctionCallOutputItem).output.length;
    n++;
  }
  if (reclaim < cfg.pruneMinChars) return cursor;
  return { ...cursor, prunedThroughTurn: cutoff, prunedChars: cursor.prunedChars + reclaim };
}

export function compactionCut(
  items: readonly Item[],
  cursor: ContextCursor,
  keepTurns: number,
): number {
  let max = 0;
  for (const i of items) max = Math.max(max, turnOf(i));
  return Math.max(cursor.compactedThroughTurn, max - keepTurns);
}

export function shouldCompact(
  items: readonly Item[],
  extraChars: number,
  cfg: Config["context"],
  cursor: ContextCursor,
): boolean {
  return approxTokens(project(items, cursor), extraChars) >= cfg.compactAtTokens;
}

export function sealDanglingCalls(items: Item[]): Item[] {
  const have = new Set(items.filter(isFunctionOutput).map((i) => i.call_id));
  const extra: Item[] = [];
  for (const i of items) {
    if (!isFunctionCall(i)) continue;
    if (have.has(i.call_id)) continue;
    extra.push({
      type: "function_call_output",
      call_id: i.call_id,
      output:
        "interrupted before the harness recorded a result; re-read and re-issue if still needed",
      meta: { ...i.meta, kind: undefined },
    });
    have.add(i.call_id);
  }
  return extra.length ? [...items, ...extra] : items;
}

export function truncateToTurn(items: Item[], turn: number): Item[] {
  return sealDanglingCalls(items.filter((i) => turnOf(i) <= turn));
}
