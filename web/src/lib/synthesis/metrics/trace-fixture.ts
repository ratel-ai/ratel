import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/pglite";
import { type NewOtelSpan, otelSpans } from "@/lib/ingest/otlp/schema";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { MetricsDb } from "@/lib/synthesis/metrics/query";
import {
  recomputeTraceSummaries,
  type TraceSummaryExecutor,
} from "@/lib/synthesis/traces/summary-refresh";

/** Traces for tests: spans as ingest stores them, with the summaries the sweep builds of them. */

export const ORG = "22222222-2222-4222-8222-222222222222";
export const PROJECT = "11111111-1111-4111-8111-111111111111";
/** Another project of the same organization: what it stores never shows in `PROJECT`. */
export const OTHER_PROJECT = "77777777-7777-4777-8777-777777777777";

type SpanSeed = Partial<NewOtelSpan> & {
  /** Seconds after the root's start. */
  after?: number;
  /** A tool span of this name, under the root. */
  tool?: string;
  skill?: string;
};

export interface TraceSeed {
  id: string;
  /** `PROJECT` unless given. */
  projectId?: string;
  startedAt: string;
  root?: Partial<NewOtelSpan>;
  /** In order, a second apart unless `after` says otherwise. */
  spans?: readonly SpanSeed[];
}

export async function traceDatabase() {
  const client = await createMigratedPGlite();
  const orm = drizzle(client, { schema });
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT}', '${ORG}', 'Agent', 'agent'),
      ('${OTHER_PROJECT}', '${ORG}', 'Other', 'fixture-other');
  `);
  return {
    client,
    db: orm as unknown as MetricsDb,
    async seed(traces: readonly TraceSeed[]) {
      await orm.insert(otelSpans).values(traces.flatMap(spansOf));
      await recomputeTraceSummaries(
        orm as unknown as TraceSummaryExecutor,
        traces.map(({ id, projectId = PROJECT }) => ({ projectId, traceId: id })),
      );
    },
  };
}

function spansOf({
  id,
  projectId = PROJECT,
  startedAt,
  root = {},
  spans = [],
}: TraceSeed): NewOtelSpan[] {
  const start = new Date(startedAt).getTime();
  const at = (seconds: number) => new Date(start + seconds * 1000);
  return [
    span({ projectId, traceId: id, spanId: `${id}-root`, startedAt: at(0), ...root }),
    ...spans.map(({ after, tool, skill, ...rest }, index) =>
      span({
        projectId,
        traceId: id,
        spanId: `${id}-${index}`,
        parentSpanId: `${id}-root`,
        startedAt: at(after ?? index + 1),
        ...(tool ? { name: `execute_tool ${tool}`, spanClass: "tool" } : {}),
        ...rest,
        attributes: {
          ...(rest.attributes ?? {}),
          ...(skill ? { "ratel.skill.name": skill } : {}),
        },
      }),
    ),
  ];
}

function span(
  rest: Partial<NewOtelSpan> & Pick<NewOtelSpan, "traceId" | "spanId" | "startedAt">,
): NewOtelSpan {
  return {
    id: randomUUID(),
    projectId: PROJECT,
    name: "run",
    kind: 1,
    spanClass: "other",
    endedAt: rest.startedAt,
    durationMs: 1,
    statusCode: 0,
    attributes: {},
    ...rest,
  };
}

/** The window of the parity fixture: three days, the first one empty. */
export const PARITY_WINDOW = {
  since: new Date("2026-11-01T00:00:00Z"),
  until: new Date("2026-11-04T00:00:00Z"),
} as const;
export const PARITY_SCORERS = {
  /** Pass or fail. */
  polite: "5f0e8a39-6f0e-4a8e-9c5c-0e4a1f1b0001",
  /** 1 to 5. */
  depth: "5f0e8a39-6f0e-4a8e-9c5c-0e4a1f1b0002",
} as const;

/**
 * The fixture of the metric form and RQL parity, in the window `PARITY_WINDOW`:
 * t1 11-02 09:10 api/prod      model-b         search     planner         files  100 ms ok
 * t2 11-02 09:40 api/prod      model-b, model-a read(failed), search  planner, helper 900 ms span failed, root ok
 * t3 11-02 11:00 worker/staging model-a        -          -               -      300 ms root failed
 * t4 11-03 08:00 worker/prod   model-a         search(failed) helper      -      700 ms root_error null (an old row)
 * t5 11-03 23:30 no property at all                                            50 ms
 * t6 10-31 23:00 api/prod: before the window, known in it (11-02 12:00)
 * t7 11-03 22:00 api/prod: in the window, known after it (11-05 01:00)
 * The others are known 5 minutes after they started. The day 11-01 is empty, and 11-03 sparse.
 * Scores: polite passes t1, t3, t6 and a trace whose summary is gone, and fails t2; depth gives
 * t1 5, t2 2, t4 4 (scored late, 11-05) and t5 3. Prompts: three in the window (one with no cost
 * and two sources missing), one before it.
 */
export async function seedMetricParity(database: Awaited<ReturnType<typeof traceDatabase>>) {
  const root = (service: string | null, environment: string | null, durationMs: number) => ({
    durationMs,
    ...(service ? { serviceName: service } : {}),
    attributes: environment ? { "deployment.environment.name": environment } : {},
  });
  const call = (model: string, input: number, output: number, cost: string) => ({
    model,
    spanClass: "llm",
    inputTokens: input,
    outputTokens: output,
    costUsd: cost,
  });
  await database.seed([
    {
      id: "t1",
      startedAt: "2026-11-02T09:10:00Z",
      root: root("api", "prod", 100),
      spans: [
        { ...call("model-b", 100, 20, "0.010000"), agentKey: "planner", mcpServer: "files" },
        { tool: "search" },
      ],
    },
    {
      id: "t2",
      startedAt: "2026-11-02T09:40:00Z",
      root: root("api", "prod", 900),
      spans: [
        { ...call("model-b", 300, 50, "0.030000"), agentKey: "planner" },
        { ...call("model-a", 30, 5, "0.003000"), agentKey: "helper" },
        { tool: "read", statusCode: 2 },
        { tool: "search" },
      ],
    },
    {
      id: "t3",
      startedAt: "2026-11-02T11:00:00Z",
      root: { ...root("worker", "staging", 300), statusCode: 2 },
      spans: [call("model-a", 50, 10, "0.002000")],
    },
    {
      id: "t4",
      startedAt: "2026-11-03T08:00:00Z",
      root: root("worker", "prod", 700),
      spans: [
        { ...call("model-a", 80, 40, "0.004000"), agentKey: "helper" },
        { tool: "search", statusCode: 2 },
      ],
    },
    { id: "t5", startedAt: "2026-11-03T23:30:00Z", root: root(null, null, 50) },
    {
      id: "t6",
      startedAt: "2026-10-31T23:00:00Z",
      root: root("api", "prod", 400),
      spans: [call("model-b", 10, 10, "0.001000")],
    },
    {
      id: "t7",
      startedAt: "2026-11-03T22:00:00Z",
      root: root("api", "prod", 200),
      spans: [call("model-b", 20, 20, "0.002000")],
    },
  ]);
  const { polite, depth } = PARITY_SCORERS;
  await database.client.exec(`
    update otel_trace_summaries set updated_at = started_at + interval '5 minutes'
      where project_id = '${PROJECT}';
    update otel_trace_summaries set updated_at = '2026-11-02T12:00:00Z' where trace_id = 't6';
    update otel_trace_summaries set updated_at = '2026-11-05T01:00:00Z' where trace_id = 't7';
    update otel_trace_summaries set root_error = null where trace_id = 't4';
    insert into trace_scorers (id, project_id, name, kind, config, created_by, updated_by) values
      ('${polite}', '${PROJECT}', 'Polite', 'check', '{}', 'a', 'a'),
      ('${depth}', '${PROJECT}', 'Depth', 'judge', '{}', 'a', 'a');
    insert into trace_scores (project_id, scorer_id, trace_id, value, passed, trace_started_at, scored_at) values
      ('${PROJECT}', '${polite}', 't1', 1, true, '2026-11-02T09:10:00Z', '2026-11-02T09:20:00Z'),
      ('${PROJECT}', '${polite}', 't2', 0, false, '2026-11-02T09:40:00Z', '2026-11-02T09:50:00Z'),
      ('${PROJECT}', '${polite}', 't3', 1, true, '2026-11-02T11:00:00Z', '2026-11-02T11:10:00Z'),
      ('${PROJECT}', '${polite}', 't6', 1, true, '2026-10-31T23:00:00Z', '2026-11-02T12:10:00Z'),
      ('${PROJECT}', '${polite}', 'gone', 1, true, '2026-11-02T10:00:00Z', '2026-11-02T10:10:00Z'),
      ('${PROJECT}', '${depth}', 't1', 5, null, '2026-11-02T09:10:00Z', '2026-11-02T09:20:00Z'),
      ('${PROJECT}', '${depth}', 't2', 2, null, '2026-11-02T09:40:00Z', '2026-11-02T09:50:00Z'),
      ('${PROJECT}', '${depth}', 't4', 4, null, '2026-11-03T08:00:00Z', '2026-11-05T02:00:00Z'),
      ('${PROJECT}', '${depth}', 't5', 3, null, '2026-11-03T23:30:00Z', '2026-11-03T23:40:00Z');
    insert into events (id, project_id, received_at, occurred_at, model) values
      ('6a000000-0000-4000-8000-000000000001', '${PROJECT}', '2026-11-02T09:00:00Z', '2026-11-02T09:00:00Z', 'model-b'),
      ('6a000000-0000-4000-8000-000000000002', '${PROJECT}', '2026-11-02T15:00:00Z', null, 'model-a'),
      ('6a000000-0000-4000-8000-000000000003', '${PROJECT}', '2026-11-03T10:00:00Z', '2026-11-03T10:00:00Z', 'model-b'),
      ('6a000000-0000-4000-8000-000000000004', '${PROJECT}', '2026-10-30T10:00:00Z', '2026-10-30T10:00:00Z', 'model-b');
    insert into event_metrics (event_id, project_id, event_time, tokens_by_category, splits, cost_usd, input_tokens, categorizer_version) values
      ('6a000000-0000-4000-8000-000000000001', '${PROJECT}', '2026-11-02T09:00:00Z',
        '{"skills": 10, "tools": 20, "history": 30, "memory": 0, "user_input": 5}', '{}', 0.01, 65, 1),
      ('6a000000-0000-4000-8000-000000000002', '${PROJECT}', '2026-11-02T15:00:00Z',
        '{"skills": 1, "tools": 2}', '{}', null, 3, 1),
      ('6a000000-0000-4000-8000-000000000003', '${PROJECT}', '2026-11-03T10:00:00Z',
        '{"skills": 4, "tools": 4, "history": 4, "memory": 4, "user_input": 4}', '{}', 0.02, 20, 1),
      ('6a000000-0000-4000-8000-000000000004', '${PROJECT}', '2026-10-30T10:00:00Z',
        '{"skills": 9, "tools": 9, "history": 9, "memory": 9, "user_input": 9}', '{}', 0.5, 45, 1);
  `);
}
