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

type SpanSeed = Partial<NewOtelSpan> & {
  /** Seconds after the root's start. */
  after?: number;
  /** A tool span of this name, under the root. */
  tool?: string;
  skill?: string;
};

export interface TraceSeed {
  id: string;
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
      ('${PROJECT}', '${ORG}', 'Agent', 'agent');
  `);
  return {
    client,
    db: orm as unknown as MetricsDb,
    async seed(traces: readonly TraceSeed[]) {
      await orm.insert(otelSpans).values(traces.flatMap(spansOf));
      await recomputeTraceSummaries(
        orm as unknown as TraceSummaryExecutor,
        traces.map(({ id }) => ({ projectId: PROJECT, traceId: id })),
      );
    },
  };
}

function spansOf({ id, startedAt, root = {}, spans = [] }: TraceSeed): NewOtelSpan[] {
  const start = new Date(startedAt).getTime();
  const at = (seconds: number) => new Date(start + seconds * 1000);
  return [
    span({ traceId: id, spanId: `${id}-root`, startedAt: at(0), ...root }),
    ...spans.map(({ after, tool, skill, ...rest }, index) =>
      span({
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
