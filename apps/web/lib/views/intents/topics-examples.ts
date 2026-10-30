import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { projectRoot } from "@/lib/console/navigation";
import { OTLP_MODEL_CALL } from "@/lib/ingest/otlp/derive-model-calls";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { getDb } from "@/lib/platform/db/client";
import {
  type AskSourceKind,
  isModelOnlyTurn,
  MODEL_ONLY_PREFIX,
  type TopicInsights,
} from "@/lib/readings/topics/types";
import { turnTracesHref } from "@/lib/readings/trace-signals/view";
import {
  type LabelDb,
  loadAskSourcesByTurn,
} from "@/lib/readings/trace-signals/workflows/label-queries";

/**
 * Example asks, read on demand when a panel opens: the stored reading names
 * the turns (ids only), and their captured asks are read from the turns' own
 * events here, never stored with the topics. Each comes with where to see the
 * run in Traces.
 */

export type ExampleTarget =
  | { kind: "topic"; topicId: string }
  /** A step of the Flows: `view` is `all` or a starting topic's id. */
  | { kind: "step"; view: string; position: number; key: string };

export interface ExampleAsk {
  id: string;
  text: string;
  source: AskSourceKind;
  /** The run in Traces. */
  href: string;
}

const MAX_TEXT = 500;

/** The turn ids the reading keeps for a topic or a flow step; none for anything it does not know. */
export function exampleTurnIds(insights: TopicInsights, target: unknown): string[] {
  if (!target || typeof target !== "object") return [];
  const record = target as Record<string, unknown>;
  if (record.kind === "topic" && typeof record.topicId === "string") {
    return insights.topics.find((topic) => topic.id === record.topicId)?.examples ?? [];
  }
  if (
    record.kind === "step" &&
    typeof record.view === "string" &&
    typeof record.position === "number" &&
    typeof record.key === "string"
  ) {
    const flows = insights.flows;
    const view = record.view === "all" ? flows?.all : flows?.byStart[record.view];
    const column = view?.columns.find((item) => item.position === record.position);
    return column?.nodes.find((node) => node.key === record.key)?.examples ?? [];
  }
  return [];
}

/** Turns tried per topic for its lead example: the first whose ask is still there wins. */
export const LEAD_CANDIDATES = 2;

/** The turn ids to read each topic's lead example from: its first few examples, by topic. */
export function leadTurnIds(insights: Pick<TopicInsights, "topics">): Map<string, string[]> {
  return new Map(
    insights.topics.map((topic) => [topic.id, topic.examples.slice(0, LEAD_CANDIDATES)]),
  );
}

/** Each topic's lead example: the first of its candidates that was read. Topics with none are left out. */
export function pickLeads(
  candidates: ReadonlyMap<string, readonly string[]>,
  read: readonly ExampleAsk[],
): Record<string, ExampleAsk> {
  const byId = new Map(read.map((example) => [example.id, example]));
  const out: Record<string, ExampleAsk> = {};
  for (const [topicId, ids] of candidates) {
    const lead = ids.map((id) => byId.get(id)).find((example) => example !== undefined);
    if (lead) out[topicId] = lead;
  }
  return out;
}

const SOURCE = { user_message: "user", prompt: "prompt", search: "search" } as const;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
}

/** The asks of the given turns, in that order; turns whose ask is gone (pruned, never captured) are left out. */
export async function loadExampleAsks(
  projectId: string,
  ids: readonly string[],
  db: LabelDb = getDb(),
): Promise<ExampleAsk[]> {
  const ledger = ids.filter((id) => !isModelOnlyTurn(id));
  const traces = ids.filter(isModelOnlyTurn).map((id) => id.slice(MODEL_ONLY_PREFIX.length));
  const [asks, prompts] = await Promise.all([
    ledger.length > 0 ? loadAskSourcesByTurn(projectId, ledger, db) : Promise.resolve(new Map()),
    traces.length > 0
      ? modelOnlyPrompts(projectId, traces, db)
      : Promise.resolve(new Map<string, string>()),
  ]);
  return ids.flatMap((id): ExampleAsk[] => {
    if (isModelOnlyTurn(id)) {
      const traceId = id.slice(MODEL_ONLY_PREFIX.length);
      const text = prompts.get(traceId);
      return text
        ? [
            {
              id,
              text: clip(text),
              source: "prompt",
              href: `${projectRoot(projectId)}/traces/${encodeURIComponent(traceId)}`,
            },
          ]
        : [];
    }
    const ask = asks.get(id);
    return ask
      ? [
          {
            id,
            text: clip(ask.text),
            source: SOURCE[ask.source as keyof typeof SOURCE] ?? "search",
            href: turnTracesHref(projectId, id),
          },
        ]
      : [];
  });
}

/** The prompt the first model call of each trace carried. */
async function modelOnlyPrompts(
  projectId: string,
  traceIds: readonly string[],
  db: LabelDb,
): Promise<Map<string, string>> {
  const at = sql`coalesce(${traceEvents.occurredAt}, ${traceEvents.receivedAt})`;
  const rows = await db
    .select({
      traceId: traceEvents.traceId,
      prompt: sql<string | null>`${traceEvents.payload} ->> 'prompt'`,
    })
    .from(traceEvents)
    .where(
      and(
        eq(traceEvents.projectId, projectId),
        eq(traceEvents.type, OTLP_MODEL_CALL),
        inArray(traceEvents.traceId, [...traceIds]),
        sql`${traceEvents.payload} ? 'prompt'`,
      ),
    )
    .orderBy(asc(at));
  const out = new Map<string, string>();
  for (const row of rows)
    if (row.traceId && row.prompt && !out.has(row.traceId)) out.set(row.traceId, row.prompt);
  return out;
}
