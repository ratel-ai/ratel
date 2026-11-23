import { and, desc, eq, inArray, isNotNull, min, type SQL, sql } from "drizzle-orm";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import type { TraceSignalRow } from "@/lib/readings/trace-signals/schema";
import { traceSignalRuns, traceSignals } from "@/lib/readings/trace-signals/schema";
import type { SelfCorrectionTrust } from "@/lib/readings/trace-signals/self-corrections/detect";
import {
  catalogEntryOf,
  SELF_CORRECTING_KIND,
} from "@/lib/readings/trace-signals/self-corrections/issues";
import type { StoredSelfCorrections } from "@/lib/readings/trace-signals/self-corrections/run";
import type {
  BucketCount,
  CorrectionExample,
  CorrectionGroup,
  SentimentCounts,
} from "@/lib/views/health/self-corrections/page-model";
import type { SelfCorrectionFilters } from "@/lib/views/health/self-corrections/paths";

/**
 * The reads behind the Self-corrections page. Every count is grouped in the
 * database, so a window of any size comes back as a few hundred groups.
 * Rows are windowed by their turn's end, like the turns they are counted
 * against, and read under the trust the reading that wrote them used (a
 * guessed run it left out is no turn here either).
 *
 * No text is read here: an example's reply is read on demand, one at a time
 * (`example.ts`).
 */

export interface PageRange {
  from: Date;
  to: Date;
}

/** Self-corrections can happen after their turn's last step (the final reply), and their turn starts before it ends. */
const OCCURRED_MARGIN_MS = 86_400_000;
const ERROR_KINDS_SQL = sql`('retry_after_error', 'switch_after_error', 'gave_up_after_error')`;
const EXAMPLES = 6;

/** The turns a page counts: closed, ending in the range, read under the trust, and matching the filters. */
function turnScope(
  projectId: string,
  range: PageRange,
  filters: SelfCorrectionFilters,
  trust: SelfCorrectionTrust,
): SQL {
  const parts: SQL[] = [
    sql`t.project_id = ${projectId}`,
    sql`t.status = 'closed'`,
    sql`t.ended_at >= ${range.from.toISOString()}::timestamptz`,
    sql`t.ended_at < ${range.to.toISOString()}::timestamptz`,
  ];
  if (trust.runs === "none") parts.push(sql`false`);
  if (trust.runs === "exact") parts.push(sql`t.turn_source <> 'inferred'`);
  if (filters.task) parts.push(sql`t.workflow_id = ${filters.task}`);
  if (filters.topic) {
    parts.push(
      sql`exists (select 1 from trace_turn_topics f where f.turn_id = t.id and f.topic_id = ${filters.topic} and f.verdict = 'topic')`,
    );
  }
  return sql.join(parts, sql` and `);
}

/** Turns that called the filtered tool, when there is one: what a tool's self-corrections are counted against. */
function calledScope(filters: SelfCorrectionFilters): SQL {
  if (!filters.tool) return sql`true`;
  const entry = catalogEntryOf(filters.tool);
  return sql`exists (select 1 from trace_turn_steps s where s.turn_id = t.id and s.kind = 'invoke' and s.target_type = ${entry.kind} and s.target_id = ${entry.id})`;
}

/** The self-corrections of the turns in scope (after the filtered tool, when there is one). */
function correctionScope(
  projectId: string,
  range: PageRange,
  filters: SelfCorrectionFilters,
  trust: SelfCorrectionTrust,
): SQL {
  const parts: SQL[] = [
    sql`sc.project_id = ${projectId}`,
    sql`sc.occurred_at >= ${new Date(range.from.getTime() - OCCURRED_MARGIN_MS).toISOString()}::timestamptz`,
    sql`sc.occurred_at < ${new Date(range.to.getTime() + OCCURRED_MARGIN_MS).toISOString()}::timestamptz`,
    turnScope(projectId, range, filters, trust),
  ];
  if (filters.tool) parts.push(sql`sc.tool_id = ${filters.tool}`);
  return sql.join(parts, sql` and `);
}

const num = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

export async function countTurns(
  db: BoundReadDb,
  projectId: string,
  range: PageRange,
  filters: SelfCorrectionFilters,
  trust: SelfCorrectionTrust,
): Promise<number> {
  const result = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from trace_turns t
    where ${turnScope(projectId, range, filters, trust)} and ${calledScope(filters)}`);
  return num(result.rows[0]?.n);
}

export async function groupCorrections(
  db: BoundReadDb,
  projectId: string,
  range: PageRange,
  filters: SelfCorrectionFilters,
  trust: SelfCorrectionTrust,
): Promise<CorrectionGroup[]> {
  const result = await db.execute<{
    kind: string;
    phrase_category: string | null;
    phrase: string | null;
    tool_id: string | null;
    workflow_id: string | null;
    topic_id: string | null;
    events: number;
  }>(sql`
    select sc.kind, sc.phrase_category, sc.phrase, sc.tool_id, t.workflow_id, tt.topic_id, count(*)::int as events
    from trace_self_corrections sc
    join trace_turns t on t.id = sc.turn_id
    left join trace_turn_topics tt on tt.turn_id = t.id and tt.verdict = 'topic'
    where ${correctionScope(projectId, range, filters, trust)}
    group by sc.kind, sc.phrase_category, sc.phrase, sc.tool_id, t.workflow_id, tt.topic_id`);
  return result.rows.map((row) => ({
    kind: row.kind,
    phraseCategory: row.phrase_category,
    phrase: row.phrase,
    toolId: row.tool_id,
    workflowId: row.workflow_id,
    topicId: row.topic_id,
    events: num(row.events),
  }));
}

/** Failed calls behind the error kinds, each once, and those a later call in the turn got past. */
export async function countFailedCalls(
  db: BoundReadDb,
  projectId: string,
  range: PageRange,
  filters: SelfCorrectionFilters,
  trust: SelfCorrectionTrust,
): Promise<{ failed: number; recovered: number }> {
  const result = await db.execute<{ failed: number; recovered: number }>(sql`
    select count(*)::int as failed, count(*) filter (where f.recovered)::int as recovered
    from (
      select sc.turn_id, sc.step_ordinal, bool_or(coalesce(sc.recovered, false)) as recovered
      from trace_self_corrections sc
      join trace_turns t on t.id = sc.turn_id
      where ${correctionScope(projectId, range, filters, trust)} and sc.kind in ${ERROR_KINDS_SQL}
      group by sc.turn_id, sc.step_ordinal
    ) f`);
  return { failed: num(result.rows[0]?.failed), recovered: num(result.rows[0]?.recovered) };
}

export async function countCorrections(
  db: BoundReadDb,
  projectId: string,
  range: PageRange,
  filters: SelfCorrectionFilters,
  trust: SelfCorrectionTrust,
): Promise<number> {
  const result = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
    from trace_self_corrections sc
    join trace_turns t on t.id = sc.turn_id
    where ${correctionScope(projectId, range, filters, trust)}`);
  return num(result.rows[0]?.n);
}

/**
 * Turns and self-corrections per bucket of `bucketDays` days counted from the
 * range's start (bucket 0 is the oldest), for the trend. Both are bucketed by
 * their turn's end, like every other count here.
 */
export async function countByBucket(
  db: BoundReadDb,
  projectId: string,
  range: PageRange,
  filters: SelfCorrectionFilters,
  trust: SelfCorrectionTrust,
  bucketDays: number,
): Promise<BucketCount[]> {
  const from = range.from.toISOString();
  const seconds = Math.max(1, Math.round(bucketDays)) * 86_400;
  const bucket = sql`floor(extract(epoch from (t.ended_at - ${from}::timestamptz)) / ${seconds}::int)::int`;
  const turns = await db.execute<{ bucket: number; n: number }>(sql`
    select ${bucket} as bucket, count(*)::int as n from trace_turns t
    where ${turnScope(projectId, range, filters, trust)} and ${calledScope(filters)}
    group by 1`);
  const events = await db.execute<{ bucket: number; n: number }>(sql`
    select ${bucket} as bucket, count(*)::int as n
    from trace_self_corrections sc
    join trace_turns t on t.id = sc.turn_id
    where ${correctionScope(projectId, range, filters, trust)}
    group by 1`);
  const out = new Map<number, BucketCount>();
  for (const row of turns.rows)
    out.set(num(row.bucket), { bucket: num(row.bucket), turns: num(row.n), events: 0 });
  for (const row of events.rows) {
    const at = num(row.bucket);
    out.set(at, { bucket: at, turns: out.get(at)?.turns ?? 0, events: num(row.n) });
  }
  return [...out.values()].sort((a, b) => a.bucket - b.bucket);
}

/** Turns per task and per topic in scope: what each one's self-corrections are counted against. */
export async function countTurnsBy(
  db: BoundReadDb,
  projectId: string,
  range: PageRange,
  filters: SelfCorrectionFilters,
  trust: SelfCorrectionTrust,
): Promise<{ tasks: Map<string, number>; topics: Map<string, number> }> {
  const scope = sql`${turnScope(projectId, range, filters, trust)} and ${calledScope(filters)}`;
  const tasks = await db.execute<{ id: string; n: number }>(sql`
    select t.workflow_id as id, count(*)::int as n from trace_turns t
    where ${scope} and t.workflow_id is not null group by t.workflow_id`);
  const topics = await db.execute<{ id: string; n: number }>(sql`
    select tt.topic_id as id, count(*)::int as n from trace_turns t
    join trace_turn_topics tt on tt.turn_id = t.id and tt.verdict = 'topic' and tt.topic_id is not null
    where ${scope} group by tt.topic_id`);
  return {
    tasks: new Map(tasks.rows.map((row) => [row.id, num(row.n)])),
    topics: new Map(topics.rows.map((row) => [row.id, num(row.n)])),
  };
}

/**
 * Self-corrections to show: the newest of each phrase (or, for behaviour, of
 * each kind), phrases with a readable reply first and then the most common,
 * so the examples vary instead of repeating one templated reply. Ids and the
 * catalog's words only.
 */
export async function listExamples(
  db: BoundReadDb,
  projectId: string,
  range: PageRange,
  filters: SelfCorrectionFilters,
  trust: SelfCorrectionTrust,
  limit: number = EXAMPLES,
): Promise<CorrectionExample[]> {
  const result = await db.execute<{
    id: string;
    turn_id: string;
    kind: string;
    phrase_category: string | null;
    phrase: string | null;
    tool_id: string | null;
    tool_outcome: string | null;
    occurred_at: string | Date;
    has_text: boolean;
    turn_key: string;
    focus_event_id: string | null;
  }>(sql`
    with scoped as (
      select sc.id, sc.turn_id, sc.kind, sc.phrase_category, sc.phrase, sc.tool_id, sc.tool_outcome, sc.occurred_at, sc.step_ordinal,
             (sc.source_event_id is not null) as has_text, t.turn_key,
             count(*) over (partition by coalesce(sc.phrase, sc.kind)) as kind_count,
             row_number() over (partition by coalesce(sc.phrase, sc.kind) order by (sc.source_event_id is not null) desc, sc.occurred_at desc, sc.id) as nth
      from trace_self_corrections sc
      join trace_turns t on t.id = sc.turn_id
      where ${correctionScope(projectId, range, filters, trust)}
    )
    select s.id, s.turn_id, s.kind, s.phrase_category, s.phrase, s.tool_id, s.tool_outcome, s.occurred_at, s.has_text, s.turn_key,
           ts.trace_event_id as focus_event_id
    from scoped s
    left join trace_turn_steps ts on ts.turn_id = s.turn_id and ts.ordinal = s.step_ordinal
    where s.nth = 1
    order by s.has_text desc, s.kind_count desc, s.occurred_at desc, s.id
    limit ${limit}`);
  return result.rows.map((row) => ({
    id: row.id,
    turnId: row.turn_id,
    kind: row.kind,
    phraseCategory: row.phrase_category,
    phrase: row.phrase,
    toolId: row.tool_id,
    toolOutcome: row.tool_outcome,
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at),
    hasText: row.has_text === true,
    turnKey: row.turn_key,
    focusEventId: row.focus_event_id,
  }));
}

/** Negative sentiment with and without a self-correction, over the turns whose sentiment was read. */
export async function countSentiment(
  db: BoundReadDb,
  projectId: string,
  range: PageRange,
  filters: SelfCorrectionFilters,
  trust: SelfCorrectionTrust,
): Promise<SentimentCounts | null> {
  const result = await db.execute<{ corrected: boolean; negative: number; measured: number }>(sql`
    select exists (select 1 from trace_self_corrections x where x.turn_id = t.id) as corrected,
           count(*) filter (where tt.sentiment = 'negative')::int as negative,
           count(*)::int as measured
    from trace_turns t
    join trace_turn_topics tt on tt.turn_id = t.id and tt.sentiment is not null
    where ${turnScope(projectId, range, filters, trust)} and ${calledScope(filters)}
    group by 1`);
  if (result.rows.length === 0) return null;
  const side = (corrected: boolean) => {
    const row = result.rows.find((r) => r.corrected === corrected);
    return { negative: num(row?.negative), measured: num(row?.measured) };
  };
  return { corrected: side(true), clean: side(false) };
}

/** The latest completed reading that wrote self-corrections, and the oldest window any such reading covered. */
export async function loadCorrectionRun(
  db: BoundReadDb,
  projectId: string,
): Promise<{
  finishedAt: Date | null;
  windowEnd: Date;
  stored: StoredSelfCorrections;
  summary: unknown;
  coveredFrom: Date | null;
} | null> {
  const wrote = and(
    eq(traceSignalRuns.projectId, projectId),
    eq(traceSignalRuns.status, "completed"),
    sql`${traceSignalRuns.summary} -> 'selfCorrections' is not null`,
  );
  const [latest] = await db
    .select({
      finishedAt: traceSignalRuns.finishedAt,
      windowEnd: traceSignalRuns.windowEnd,
      summary: traceSignalRuns.summary,
    })
    .from(traceSignalRuns)
    .where(wrote)
    .orderBy(desc(traceSignalRuns.createdAt))
    .limit(1);
  if (!latest) return null;
  const stored = (latest.summary as { selfCorrections?: StoredSelfCorrections } | null)
    ?.selfCorrections;
  if (!stored || stored.version !== 1) return null;
  const [covered] = await db
    .select({ from: min(traceSignalRuns.windowStart) })
    .from(traceSignalRuns)
    .where(wrote);
  return {
    finishedAt: latest.finishedAt,
    windowEnd: latest.windowEnd,
    stored,
    summary: latest.summary,
    coveredFrom: covered?.from ?? null,
  };
}

/** Open and acknowledged `self_correcting` issues, worst first. */
export async function listOpenCorrectionIssues(
  db: BoundReadDb,
  projectId: string,
): Promise<TraceSignalRow[]> {
  return db
    .select()
    .from(traceSignals)
    .where(
      and(
        eq(traceSignals.projectId, projectId),
        eq(traceSignals.kind, SELF_CORRECTING_KIND),
        inArray(traceSignals.status, ["open", "acknowledged"]),
        isNotNull(traceSignals.subjectKey),
      ),
    )
    .orderBy(desc(traceSignals.severity), desc(traceSignals.impact));
}
