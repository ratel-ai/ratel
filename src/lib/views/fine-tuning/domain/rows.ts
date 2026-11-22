import { createHash } from "node:crypto";
import type { CloudMessage, CloudToolDef } from "@/lib/ingest/cloud-schema";
import { scoreRun } from "../../task-scorers/engine";
import type { Scorer, ScorerRun } from "../../task-scorers/types";
import {
  addCounts,
  type CallContent,
  emptyCounts,
  REDACTION_VERSION,
  type RedactionCounts,
  redactCall,
} from "./redaction";
import type { UseCaseSelector } from "./use-case";

/**
 * The row pipeline of a dataset build (RC-1127). Pure: no I/O, no clock, no
 * randomness. For each turn of a use case, in this order:
 *
 * 1. Quality filter, per turn. An excluded turn or call never enters. A pinned
 *    one skips the filter. Otherwise every enabled deterministic task scorer
 *    (`judge_criteria` is skipped) and every user scorer result must not be
 *    `fail`; a `skip` (not measured) does not drop. Optional rules: no error,
 *    no self-correction.
 * 2. Redaction of each call ({@link redactCall}).
 * 3. Dedup on the redacted input (system + messages + tools): `exact` on its
 *    canonical JSON, `near` on its normalized text. The earliest row stays.
 * 4. Split by connected group: turns that share a session id or an end-user
 *    key, directly or through a chain, form one group ({@link splitGroups}).
 *    A hash of (seed, group key) against the eval fraction picks its side. A
 *    group with a turn in `task_eval_cases` goes to eval whole. So no session
 *    and no end user is ever on both sides.
 *
 * Calls go through steps 2 to 4 in one global order, {@link callOrder}:
 * capture time, then event id. So the earliest call of a duplicate group
 * stays, whichever turn it belongs to, and the ordinals follow that order.
 * {@link DatasetRowBuilder} takes that order page by page, so a job can build
 * in pages and resume: {@link DatasetRowBuilder.resume} replays the rows it
 * stored, which rebuilds the dedup state (a dropped duplicate adds no key).
 */

export const DEDUP_RULES = ["off", "exact", "near"] as const;
export type DedupRule = (typeof DEDUP_RULES)[number];
export type DatasetSide = "train" | "eval";

export const DEFAULT_EVAL_FRACTION = 0.1;
export const DEFAULT_DEDUP: DedupRule = "near";

export const DROP_REASONS = [
  "excluded",
  "scorer_failed",
  "user_scorer_failed",
  "error",
  "self_correction",
  "no_content",
  "no_output",
  "duplicate_exact",
  "duplicate_near",
] as const;
export type DropReason = (typeof DROP_REASONS)[number];
export type DropCounts = Record<DropReason, number>;

export interface QualityFilters {
  /** Drop a turn with `trace_turns.error_count > 0`. */
  noError: boolean;
  /** Drop a turn with a row in `trace_self_corrections`. */
  noSelfCorrection: boolean;
}

/** What a dataset version records about how it was built. */
export interface BuildSettings {
  selector: UseCaseSelector;
  filters: QualityFilters;
  dedup: DedupRule;
  seed: number;
  evalFraction: number;
  redactionVersion: number;
}

/** One model call of a turn, with its stored content (null when the call kept none). */
export interface CandidateCall {
  traceId: string;
  spanId: string;
  /** The `events` row id: breaks ties between calls captured at the same time. */
  eventId: string;
  capturedAt: Date;
  content: (CallContent & { input_message_count?: number }) | null;
}

/** One turn of the use case, with what the filter reads. */
export interface CandidateTurn {
  turnId: string;
  taskId: string | null;
  sessionId: string | null;
  endUserKey: string | null;
  errorCount: number;
  selfCorrections: number;
  /** The measured run the task scorers read; null when unknown (every scorer skips). */
  scorerRun: ScorerRun | null;
  /** The user scorer results of the turn (`run_scores`). */
  userScores: readonly { status: "pass" | "fail" | "skip" }[];
  calls: readonly CandidateCall[];
}

/** Per-build context the filter and the split read. */
export interface BuildContext {
  /** Enabled task scorers, by task id. */
  scorersByTask: ReadonlyMap<string, readonly Scorer[]>;
  /** Turn ids or call keys (`traceId:spanId`) the use case pinned. */
  pinned: ReadonlySet<string>;
  /** Turn ids or call keys the use case excluded. */
  excluded: ReadonlySet<string>;
  /**
   * The split group of each turn, over ALL the build's turns: see
   * {@link splitGroups}. A turn missing from it is its own group.
   */
  groups: ReadonlyMap<string, string>;
  /** Group keys that go to eval whole: see {@link forcedEvalGroups}. */
  forcedEval: ReadonlySet<string>;
}

/** The row content: the redacted input and the reply. */
export interface RowContent {
  system?: string;
  tools?: CloudToolDef[];
  messages: CloudMessage[];
  output: CloudMessage[];
}

export interface DatasetRow {
  ordinal: number;
  side: DatasetSide;
  content: RowContent;
  rowHash: string;
  traceId: string;
  spanId: string;
  turnId: string;
  capturedAt: Date;
}

/** A stored row a resumed build replays. */
export type StoredRow = Pick<DatasetRow, "ordinal" | "content" | "rowHash">;

/** One call with its turn: the unit the builder takes. */
export interface CallEntry {
  turn: CandidateTurn;
  call: CandidateCall;
}

export interface BuildResult {
  rows: DatasetRow[];
  dropped: DropCounts;
  redaction: RedactionCounts;
  contentHash: string;
}

/** The settings with their defaults. */
export function buildSettings(
  selector: UseCaseSelector,
  input: Partial<Omit<BuildSettings, "selector" | "redactionVersion">> = {},
): BuildSettings {
  return {
    selector,
    filters: {
      noError: input.filters?.noError ?? false,
      noSelfCorrection: input.filters?.noSelfCorrection ?? false,
    },
    dedup: input.dedup ?? DEFAULT_DEDUP,
    seed: input.seed ?? 0,
    evalFraction: input.evalFraction ?? DEFAULT_EVAL_FRACTION,
    redactionVersion: REDACTION_VERSION,
  };
}

/** Build every row at once. Turns in any order; the builder sorts them oldest first. */
export function buildRows(
  turns: readonly CandidateTurn[],
  settings: BuildSettings,
  context: Omit<BuildContext, "forcedEval" | "groups"> & { evalCaseTurnIds: ReadonlySet<string> },
): BuildResult {
  const groups = splitGroups(turns);
  const builder = new DatasetRowBuilder(settings, {
    ...context,
    groups,
    forcedEval: forcedEvalGroups(groups, context.evalCaseTurnIds),
  });
  builder.add(callOrder(turns));
  return builder.result();
}

/**
 * Builds rows page by page. Feed it turns oldest first: dedup keeps the first
 * row it sees. Rows get ordinals in the order they are kept.
 */
export class DatasetRowBuilder {
  private readonly rows: DatasetRow[] = [];
  private readonly seen = new Set<string>();
  private dropped = emptyDrops();
  private redaction = emptyCounts();
  private nextOrdinal = 0;

  constructor(
    private readonly settings: BuildSettings,
    private readonly context: BuildContext,
  ) {}

  /**
   * Replay rows stored by an earlier run, so dedup and ordinals continue. The
   * drop and redaction counts of that run come back with them.
   */
  resume(
    stored: readonly StoredRow[],
    counts: { dropped: DropCounts; redaction: RedactionCounts },
  ): void {
    for (const row of [...stored].sort((a, b) => a.ordinal - b.ordinal)) {
      for (const key of this.dedupKeys(row.content)) this.seen.add(key);
      this.nextOrdinal = Math.max(this.nextOrdinal, row.ordinal + 1);
    }
    this.dropped = { ...counts.dropped };
    this.redaction = { ...counts.redaction };
  }

  /** Process one page of calls, in {@link callOrder}; returns the rows it kept. */
  add(entries: readonly CallEntry[]): DatasetRow[] {
    const kept: DatasetRow[] = [];
    const drops = new Map<CandidateTurn, DropReason | null>();
    for (const { turn, call } of entries) {
      if (!drops.has(turn)) drops.set(turn, this.turnDrop(turn));
      const row = this.callRow(turn, call, drops.get(turn) ?? null);
      if (row) kept.push(row);
    }
    this.rows.push(...kept);
    return kept;
  }

  /** The counts so far; a paged build stores them with each page. */
  counts(): { dropped: DropCounts; redaction: RedactionCounts } {
    return { dropped: { ...this.dropped }, redaction: { ...this.redaction } };
  }

  /** The rows this builder kept (not the replayed ones), the counts and the content hash of those rows. */
  result(): BuildResult {
    return {
      rows: [...this.rows],
      ...this.counts(),
      contentHash: contentHashOf(this.rows.map((row) => row.rowHash)),
    };
  }

  private turnDrop(turn: CandidateTurn): DropReason | null {
    if (this.context.excluded.has(turn.turnId)) return "excluded";
    if (this.context.pinned.has(turn.turnId)) return null;
    return qualityDrop(turn, this.settings.filters, this.context.scorersByTask);
  }

  private callRow(
    turn: CandidateTurn,
    call: CandidateCall,
    turnDrop: DropReason | null,
  ): DatasetRow | null {
    const key = callKey(call);
    if (this.context.excluded.has(key)) return this.drop("excluded");
    if (turnDrop && !(turnDrop !== "excluded" && this.context.pinned.has(key)))
      return this.drop(turnDrop);
    if (!call.content) return this.drop("no_content");

    const { content: redacted, counts } = redactCall(call.content);
    const content = rowContent(redacted, call.content.input_message_count);
    if (content.output.length === 0) return this.drop("no_output");

    const keys = this.dedupKeys(content);
    const duplicate = keys.find((dedupKey) => this.seen.has(dedupKey));
    if (duplicate)
      return this.drop(duplicate.startsWith("near:") ? "duplicate_near" : "duplicate_exact");
    for (const dedupKey of keys) this.seen.add(dedupKey);

    this.redaction = addCounts(this.redaction, counts);
    const side = sideOf(
      this.context.groups.get(turn.turnId) ?? ownGroup(turn.turnId),
      this.settings,
      this.context.forcedEval,
    );
    return {
      ordinal: this.nextOrdinal++,
      side,
      content,
      rowHash: rowHashOf(side, content),
      traceId: call.traceId,
      spanId: call.spanId,
      turnId: turn.turnId,
      capturedAt: call.capturedAt,
    };
  }

  private dedupKeys(content: RowContent): string[] {
    if (this.settings.dedup === "off") return [];
    const input = canonicalJson(inputOf(content));
    const exact = `exact:${sha256(input)}`;
    return this.settings.dedup === "exact"
      ? [exact]
      : [exact, `near:${sha256(normalizeForNearDedup(input))}`];
  }

  private drop(reason: DropReason): null {
    this.dropped[reason] += 1;
    return null;
  }
}

/**
 * The split group of each turn: a union-find over the non-null session ids
 * and end-user keys, so turns that share either one, directly or through a
 * chain, are one group. A null never joins turns; a turn with neither key is
 * its own group. The key is the smallest turn id of the group, so it does not
 * depend on the input order.
 */
export function splitGroups(
  turns: readonly Pick<CandidateTurn, "turnId" | "sessionId" | "endUserKey">[],
): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (node: string): string => {
    let root = node;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let at = node; at !== root; ) {
      const next = parent.get(at)!;
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  const add = (node: string) => {
    if (!parent.has(node)) parent.set(node, node);
  };
  const union = (a: string, b: string) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const turn of turns) {
    const node = `t:${turn.turnId}`;
    add(node);
    for (const key of [
      turn.sessionId === null ? null : `s:${turn.sessionId}`,
      turn.endUserKey === null ? null : `u:${turn.endUserKey}`,
    ]) {
      if (key === null) continue;
      add(key);
      union(node, key);
    }
  }
  const smallest = new Map<string, string>();
  for (const turn of turns) {
    const root = find(`t:${turn.turnId}`);
    const current = smallest.get(root);
    if (current === undefined || turn.turnId < current) smallest.set(root, turn.turnId);
  }
  return new Map(
    turns.map((turn) => [turn.turnId, ownGroup(smallest.get(find(`t:${turn.turnId}`))!)]),
  );
}

/** The groups with a turn in `task_eval_cases`: the whole group goes to eval. */
export function forcedEvalGroups(
  groups: ReadonlyMap<string, string>,
  evalCaseTurnIds: ReadonlySet<string>,
): Set<string> {
  return new Set(
    [...groups].filter(([turnId]) => evalCaseTurnIds.has(turnId)).map(([, group]) => group),
  );
}

/** The side of a group: forced eval, else hash(seed, key) as a fraction of 2^32 against the eval fraction. */
export function sideOf(
  groupKey: string,
  settings: Pick<BuildSettings, "seed" | "evalFraction">,
  forcedEval: ReadonlySet<string>,
): DatasetSide {
  if (forcedEval.has(groupKey)) return "eval";
  const bucket = parseInt(sha256(`${settings.seed}:${groupKey}`).slice(0, 8), 16) / 2 ** 32;
  return bucket < settings.evalFraction ? "eval" : "train";
}

/** sha256 of the canonical JSON of the side and the content. */
export function rowHashOf(side: DatasetSide, content: RowContent): string {
  return sha256(canonicalJson({ side, content }));
}

/** The dataset's content hash: sha256 of its row hashes in ordinal order, one per line. */
export function contentHashOf(rowHashes: readonly string[]): string {
  return sha256(rowHashes.join("\n"));
}

/** Lower case, white space collapsed, every digit masked as 0. */
export function normalizeForNearDedup(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/\d/g, "0").trim();
}

/** Every call of the turns, in the global build order: capture time, then event id. */
export function callOrder(turns: readonly CandidateTurn[]): CallEntry[] {
  return turns
    .flatMap((turn) => turn.calls.map((call) => ({ turn, call })))
    .sort((a, b) => compareCalls(a.call, b.call));
}

/** The global build order of two calls: capture time, then event id. */
export function compareCalls(
  a: Pick<CandidateCall, "capturedAt" | "eventId">,
  b: Pick<CandidateCall, "capturedAt" | "eventId">,
): number {
  return (
    a.capturedAt.getTime() - b.capturedAt.getTime() ||
    (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0)
  );
}

/** JSON with object keys sorted, so equal values give equal text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function emptyDrops(): DropCounts {
  return Object.fromEntries(DROP_REASONS.map((reason) => [reason, 0])) as DropCounts;
}

function ownGroup(turnId: string): string {
  return `group:${turnId}`;
}

function qualityDrop(
  turn: CandidateTurn,
  filters: QualityFilters,
  scorersByTask: BuildContext["scorersByTask"],
): DropReason | null {
  const scorers = (turn.taskId ? (scorersByTask.get(turn.taskId) ?? []) : []).filter(
    (scorer) => scorer.kind !== "judge_criteria",
  );
  if (
    turn.scorerRun &&
    scoreRun(turn.scorerRun, scorers).some((result) => result.status === "fail")
  )
    return "scorer_failed";
  if (turn.userScores.some((score) => score.status === "fail")) return "user_scorer_failed";
  if (filters.noError && turn.errorCount > 0) return "error";
  if (filters.noSelfCorrection && turn.selfCorrections > 0) return "self_correction";
  return null;
}

/** The input messages and the reply. Old rows with no input count: all messages are input. */
function rowContent(content: CallContent, inputCount: number | undefined): RowContent {
  const messages =
    inputCount === undefined ? content.messages : content.messages.slice(0, inputCount);
  const output =
    content.output ?? (inputCount === undefined ? [] : content.messages.slice(inputCount));
  return {
    ...(content.system !== undefined ? { system: content.system } : {}),
    ...(content.tools !== undefined ? { tools: content.tools } : {}),
    messages,
    output,
  };
}

function inputOf(content: RowContent): Omit<RowContent, "output"> {
  return {
    system: content.system ?? null,
    tools: content.tools ?? [],
    messages: content.messages,
  } as Omit<RowContent, "output">;
}

function callKey(call: Pick<CandidateCall, "traceId" | "spanId">): string {
  return `${call.traceId}:${call.spanId}`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
