import { z } from "zod";
import {
  CHECK_OPERATORS,
  isCheckPath,
  isComparable,
  MAX_PATH_CHARS,
  MAX_VALUE_CHARS,
} from "@/lib/contracts/check";
import { hasNoNul, NUL_PROBLEM, shownValue } from "@/lib/contracts/json-text";
import { filterProblem, MAX_FILTER_BYTES } from "./filter-budget";

/**
 * The query object: the one JSON contract of dashboards, alerts and MCP. It says what to measure,
 * never over which time: the window is a separate argument of whoever runs it. The measures table
 * is the whole vocabulary; `synthesis/metrics` runs it. Kind `sql` is the exception: RQL text with
 * the RQL version it was written in, which `synthesis/rql` compiles and runs.
 * `docs/schemas/query.schema.json` is generated from this file (`pnpm schemas:generate`).
 */

export const QUERY_VERSION = 1;
export const QUERY_KINDS = [
  "metric",
  "flow",
  "step_flow",
  "funnel",
  "clusters",
  "geography",
  "sql",
] as const;
export type QueryKind = (typeof QUERY_KINDS)[number];

/** What a flow moves between. */
export const FLOW_NODES = ["tool", "skill", "agent"] as const;
export type FlowNode = (typeof FLOW_NODES)[number];
/** `steps` is the nodes kept of each path; `edges` the edges kept of the result. */
export const FLOW_LIMITS = {
  steps: { min: 2, max: 8, default: 5 },
  edges: { min: 1, max: 200, default: 50 },
} as const;

/** What a step of a step flow is. */
export const STEP_FLOW_NODES = [...FLOW_NODES, "mcp_server", "model"] as const;
export type StepFlowNode = (typeof STEP_FLOW_NODES)[number];
/** What the start column tells apart. */
export const STEP_FLOW_STARTS = ["none", "agent", "intent"] as const;
export type StepFlowStart = (typeof STEP_FLOW_STARTS)[number];
/** "every_call": forward from the start. "before": back from the first visit of one node. */
export const STEP_FLOW_MODES = ["every_call", "before"] as const;
export type StepFlowMode = (typeof STEP_FLOW_MODES)[number];
/** `steps` is the columns before Later; `nodes` the nodes of a column before its bucket. */
export const STEP_FLOW_LIMITS = {
  steps: { min: 1, max: 6, default: 3 },
  nodes: { min: 1, max: 20, default: 7 },
} as const;

export const FUNNEL_STEPS = { min: 2, max: 8 } as const;
/** "in_order": a trace meets each step after the one before. */
export const FUNNEL_ORDERS = ["in_order", "any_order"] as const;
export type FunnelOrder = (typeof FUNNEL_ORDERS)[number];
/** Of the stored intent map: the clusters themselves, or the tools they call. */
export const CLUSTERS_VIEWS = ["asks", "tools"] as const;
export type ClustersView = (typeof CLUSTERS_VIEWS)[number];

/** The world by country, or one country by region. */
export const GEOGRAPHY_LEVELS = ["world", "country"] as const;
export type GeographyLevel = (typeof GEOGRAPHY_LEVELS)[number];

/** The longest RQL text of a `sql` query, in characters: `RQL_LIMITS.maxTextChars` of the compiler. */
export const MAX_SQL_TEXT = 4_000;

export const MAX_STEP_NAME = 80;
export const AGGREGATIONS = ["count", "rate", "sum", "avg", "p50", "p95"] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

export const DIMENSIONS = ["model", "service", "environment", "agent", "tool", "scorer"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
/** The dimensions one query may group by. */
export const MAX_DIMENSIONS = 2;

export const BUCKETS = ["hour", "day"] as const;
export type Bucket = (typeof BUCKETS)[number];

interface MeasureRules {
  label: string;
  /** The first one is the default. */
  aggregations: readonly [Aggregation, ...Aggregation[]];
  dimensions: readonly Dimension[];
  buckets: readonly Bucket[];
  /** Whether trace filters apply. */
  filterable: boolean;
  /** Whether it can be limited to one scorer. */
  byScorer: boolean;
}

const TRACES = {
  dimensions: ["model", "service", "environment", "agent", "tool"],
  buckets: ["hour", "day"],
  filterable: true,
  byScorer: false,
} as const;
const CONTEXT = { dimensions: [], buckets: ["day"], filterable: false, byScorer: false } as const;
const SCORES = {
  dimensions: ["scorer", "model", "service", "environment"],
  buckets: ["hour", "day"],
  filterable: true,
  byScorer: true,
} as const;

/** Each measure with what a query may ask of it. */
export const MEASURES = {
  trace_count: { ...TRACES, label: "Traces", aggregations: ["count"] },
  error_rate: { ...TRACES, label: "Error rate", aggregations: ["rate"] },
  latency: { ...TRACES, label: "Latency", aggregations: ["p50", "p95"] },
  tokens: { ...TRACES, label: "Tokens", aggregations: ["sum", "avg"] },
  cost: { ...TRACES, label: "Cost", aggregations: ["sum", "avg"] },
  context_tokens: { ...CONTEXT, label: "Context tokens", aggregations: ["sum"] },
  context_cost: { ...CONTEXT, label: "Context cost", aggregations: ["sum"] },
  scorer_pass_rate: { ...SCORES, label: "Scorer pass rate", aggregations: ["rate"] },
  scorer_average: { ...SCORES, label: "Scorer average", aggregations: ["avg"] },
  scorer_count: { ...SCORES, label: "Scorer results", aggregations: ["count"] },
} as const satisfies Record<string, MeasureRules>;
export type MeasureId = keyof typeof MEASURES;
export const MEASURE_IDS = Object.keys(MEASURES) as [MeasureId, ...MeasureId[]];

export type Query = z.infer<typeof querySchema>;
export type MetricQuery = Extract<Query, { kind: "metric" }>;
export type FlowQuery = Extract<Query, { kind: "flow" }>;
export type StepFlowQuery = Extract<Query, { kind: "step_flow" }>;
export type FunnelQuery = Extract<Query, { kind: "funnel" }>;
export type FunnelStep = FunnelQuery["steps"][number];
export type FunnelCondition = FunnelStep["condition"];
export type ClustersQuery = Extract<Query, { kind: "clusters" }>;
export type GeographyQuery = Extract<Query, { kind: "geography" }>;
export type SqlQuery = Extract<Query, { kind: "sql" }>;
export type QueryFilters = MetricQuery["filters"];
/** The query as a document carries it between projects. */
export type PortableQuery = z.infer<typeof portableQuerySchema>;

export type ParsedQuery = { ok: true; query: Query } | { ok: false; error: string };

/** A query from outside, or what is wrong with it in words a person can act on. */
export function parseQuery(raw: unknown): ParsedQuery {
  const parsed = querySchema.safeParse(raw, { error: ({ path }) => invalidAt(path) });
  return parsed.success
    ? { ok: true, query: parsed.data }
    : { ok: false, error: parsed.error.issues[0].message };
}

/** A query of one measure, with nothing else said unless given. */
export function metricQuery(
  measure: MeasureId,
  aggregation: Aggregation,
  rest: Partial<Pick<MetricQuery, "dimensions" | "filters" | "bucket">> = {},
): MetricQuery {
  return {
    version: QUERY_VERSION,
    kind: "metric",
    measures: [{ measure, aggregation }],
    dimensions: [],
    filters: {},
    ...rest,
  };
}

/** A flow of one node type, with nothing else said unless given. */
export function flowQuery(node: FlowNode, rest: Partial<Omit<FlowQuery, "kind" | "node">> = {}) {
  const { steps, edges } = FLOW_LIMITS;
  return {
    version: QUERY_VERSION,
    kind: "flow",
    node,
    steps: steps.default,
    edges: edges.default,
    filters: {},
    ...rest,
  } satisfies FlowQuery;
}

/** A step flow of one node type, forward from the agents unless given. */
export function stepFlowQuery(
  node: StepFlowNode,
  rest: Partial<Omit<StepFlowQuery, "version" | "kind" | "node">> = {},
): StepFlowQuery {
  const { steps, nodes } = STEP_FLOW_LIMITS;
  return {
    version: QUERY_VERSION,
    kind: "step_flow",
    node,
    start: "agent",
    mode: "every_call",
    steps: steps.default,
    nodes: nodes.default,
    filters: {},
    ...rest,
  };
}

/** A funnel of steps, in order unless given. */
export function funnelQuery(
  steps: FunnelStep[],
  rest: Partial<Pick<FunnelQuery, "order" | "filters">> = {},
): FunnelQuery {
  return { version: QUERY_VERSION, kind: "funnel", order: "in_order", steps, filters: {}, ...rest };
}

/** A view of the stored intent map, whole unless given. */
export function clustersQuery(
  view: ClustersView,
  rest: Partial<Omit<ClustersQuery, "version" | "kind" | "view">> = {},
): ClustersQuery {
  return { version: QUERY_VERSION, kind: "clusters", view, ...rest };
}

/** A measure by place, of the world unless a country is given. */
export function geographyQuery(
  measure: MeasureId,
  aggregation: Aggregation,
  { country, filters = {} }: Partial<Pick<GeographyQuery, "country" | "filters">> = {},
): GeographyQuery {
  return {
    version: QUERY_VERSION,
    kind: "geography",
    measures: [{ measure, aggregation }],
    level: country ? "country" : "world",
    ...(country ? { country } : {}),
    filters,
  };
}

/** A filter that keeps every trace. */
export function isEmptyFilter(filters: object): boolean {
  return Object.values(filters).every(
    (value) => value === undefined || (Array.isArray(value) && value.length === 0),
  );
}

function invalidAt(path: readonly PropertyKey[] | undefined): string {
  return path?.length ? `The query is invalid at "${path.join(".")}".` : "The query is invalid.";
}

// `MAX_FILTER_BYTES` bounds a filter as a whole; these bound one list and one value.
const values = z
  .array(z.string().trim().min(1).max(2_000).refine(hasNoNul, NUL_PROBLEM))
  .max(1_000);
const threshold = z.number().nonnegative();

/** One clause. Values of one property are alternatives; properties combine. */
const clauseShape = {
  models: values.optional(),
  tools: values.optional(),
  services: values.optional(),
  environments: values.optional(),
  agents: values.optional(),
  mcpServers: values.optional(),
  status: z.enum(["failed", "ok"]).optional(),
  minCostUsd: threshold.optional(),
  minTokens: threshold.optional(),
};

/**
 * A filter is a list of clauses that must all match: its own properties are the first, `and` has
 * the others. A filter without `and` is a list of one.
 */
export const traceFilterShape = {
  ...clauseShape,
  and: z
    .array(z.strictObject(clauseShape))
    .optional()
    .describe("More clauses: a trace must match every one, also on the same property."),
};

const FILTER_LENGTH = `All clauses together with the filters of the page or dashboard: ${MAX_FILTER_BYTES.toLocaleString("en-US")} bytes of JSON at most.`;

/** A filter within the budget, with what else the kind filters by. */
function filtersWith<S extends z.ZodRawShape>(more: S) {
  return z
    .strictObject({ ...traceFilterShape, ...more })
    .refine((filters) => filterProblem(filters) === null, {
      error: ({ input }) => filterProblem(input as object) ?? "",
    })
    .default({} as never)
    .describe(FILTER_LENGTH);
}

const measureSchema = z.discriminatedUnion(
  "measure",
  MEASURE_IDS.map((measure) => measureOption(measure)) as [
    ReturnType<typeof measureOption>,
    ...ReturnType<typeof measureOption>[],
  ],
  {
    error: ({ input }) =>
      `Unknown measure "${shownValue((input as { measure?: unknown } | null | undefined)?.measure)}".`,
  },
);

const version = z.literal(QUERY_VERSION, {
  error: ({ input }) =>
    `Unknown query version "${shownValue(input)}". The version is ${QUERY_VERSION}.`,
});
const traceFilters = filtersWith({});
const name = z.string().trim().min(1).max(500).refine(hasNoNul, NUL_PROBLEM);

const flowSchema = z.strictObject({
  version,
  kind: z.literal("flow"),
  node: z.enum(FLOW_NODES, {
    error: ({ input }) => `A flow cannot move between "${shownValue(input)}".`,
  }),
  start: name.optional().describe("Paths start at its first appearance; other traces are out."),
  end: name.optional().describe("Paths end at its first appearance; other traces are out."),
  steps: limit(FLOW_LIMITS.steps, "flow", "steps").describe("The nodes kept of each path."),
  edges: limit(FLOW_LIMITS.edges, "flow", "edges").describe(
    "The edges kept, the most traces first.",
  ),
  filters: traceFilters,
});

const stepFlowSchema = z
  .strictObject({
    version,
    kind: z.literal("step_flow"),
    node: z.enum(STEP_FLOW_NODES, {
      error: ({ input }) =>
        `A step flow has no steps of "${shownValue(input)}". The node types are: ${STEP_FLOW_NODES.join(", ")}.`,
    }),
    start: z
      .enum(STEP_FLOW_STARTS)
      .default("agent")
      .describe("What the start column tells apart. intent: the intent each trace was placed in."),
    mode: z
      .enum(STEP_FLOW_MODES)
      .default("every_call")
      .describe("every_call: forward from the start. before: back from the first visit of target."),
    target: name.optional().describe("For mode before: the node whose earlier steps are shown."),
    steps: limit(STEP_FLOW_LIMITS.steps, "step flow", "steps").describe(
      "The steps with a column of their own; the rest fold into Later.",
    ),
    nodes: limit(STEP_FLOW_LIMITS.nodes, "step flow", "nodes per column").describe(
      "The nodes named in a column, the most traces first; the rest fold into one.",
    ),
    filters: traceFilters,
  })
  .superRefine(({ mode, target }, context) => {
    const refuse = (message: string) =>
      context.addIssue({ code: "custom", message, path: ["target"] });
    if (mode === "before" && target === undefined)
      refuse('Choose the node to look before, in "target".');
    if (mode !== "before" && target !== undefined) refuse('Only mode "before" has a target.');
  });

/** It reads the stored analysis, not traces: no trace filter and no time range. */
const clustersSchema = z
  .strictObject({
    version,
    kind: z.literal("clusters"),
    view: z.enum(CLUSTERS_VIEWS),
    clusters: values.optional().describe("By name, as tools, skills and tasks."),
    tools: values.optional(),
    skills: values.optional(),
    tasks: values.optional(),
    minSize: z
      .int("The minimum size is a whole number of asks.")
      .min(0, "The minimum size is a whole number of asks.")
      .max(1_000_000)
      .optional()
      .describe("Asks in a cluster."),
  })
  .superRefine(({ clusters, tools, skills, tasks }, context) => {
    const message = filterProblem({ clusters, tools, skills, tasks });
    if (message) context.addIssue({ code: "custom", message });
  });

const RQL_VERSION_PROBLEM = "Give the RQL version the query was written in: a whole number from 1.";
const SQL_TEXT_PROBLEM = "Write the RQL text of the query.";

/**
 * RQL text: one SELECT over the `rql` tables. No trace filter: the text says what it keeps. The
 * window of whoever runs it is its window; a time condition in the text narrows it.
 */
const sqlSchema = z.strictObject({
  version,
  kind: z.literal("sql"),
  text: z
    .string(SQL_TEXT_PROBLEM)
    .trim()
    .min(1, SQL_TEXT_PROBLEM)
    .max(
      MAX_SQL_TEXT,
      `The RQL text has at most ${MAX_SQL_TEXT.toLocaleString("en-US")} characters.`,
    )
    .refine(hasNoNul, NUL_PROBLEM)
    .describe("One RQL SELECT statement."),
  rqlVersion: z
    .int(RQL_VERSION_PROBLEM)
    .min(1, RQL_VERSION_PROBLEM)
    .describe("The RQL version the text was written in. A saved query is compiled again at load."),
});

/** One check, as a check scorer stores it. */
const checkSchema = z
  .strictObject({
    type: z.literal("attribute"),
    path: z
      .string()
      .trim()
      .max(MAX_PATH_CHARS)
      .refine(hasNoNul, NUL_PROBLEM)
      .refine(isCheckPath, "Choose what to read, and give an attribute its key."),
    op: z.enum(CHECK_OPERATORS),
    value: z
      .union([
        z
          .string()
          .trim()
          .min(1, "Give the check a value to compare with.")
          .max(MAX_VALUE_CHARS)
          .refine(hasNoNul, NUL_PROBLEM),
        z.number(),
        z.boolean(),
      ])
      .optional(),
  })
  .superRefine(({ op, value }, context) => {
    const refuse = (message: string) =>
      context.addIssue({ code: "custom", message, path: ["value"] });
    if (op === "exists") {
      if (value !== undefined) refuse("This operator compares with nothing.");
    } else if (value === undefined) refuse("Give the check a value to compare with.");
    else if (!isComparable(op, value)) refuse("This operator compares with a number.");
  });

/** Inside a project a scorer is its id. */
export const querySchema = queryWith(z.strictObject({ id: z.guid("Unknown scorer.") }));
/** Between projects a scorer is its name: no database id leaves. */
export const portableQuerySchema = queryWith(
  z.strictObject({ name: z.string().trim().min(1).max(200).refine(hasNoNul, NUL_PROBLEM) }),
);

function measureOption<M extends MeasureId>(measure: M) {
  const { label, aggregations } = MEASURES[measure] as MeasureRules;
  return z.strictObject({
    measure: z.literal(measure),
    aggregation: z.enum(aggregations, {
      error: ({ input }) => `${label} cannot be aggregated by "${shownValue(input)}".`,
    }),
  });
}

function limit(
  { min, max, default: usual }: { min: number; max: number; default: number },
  kind: string,
  what: string,
) {
  const message = `A ${kind} has ${min} to ${max} ${what}.`;
  return z.int(message).min(min, message).max(max, message).default(usual);
}

function queryWith<S extends z.ZodType>(scorer: S) {
  return z.discriminatedUnion(
    "kind",
    [
      metricQueryWith(scorer),
      flowSchema,
      stepFlowSchema,
      funnelWith(scorer),
      clustersSchema,
      geographyWith(scorer),
      sqlSchema,
    ],
    {
      error: ({ input }) =>
        `Unknown query kind "${shownValue((input as { kind?: unknown } | null | undefined)?.kind)}". The kinds are: ${QUERY_KINDS.join(", ")}.`,
    },
  );
}

function geographyWith<S extends z.ZodType>(scorer: S) {
  return z
    .strictObject({
      version,
      kind: z.literal("geography"),
      measures: z
        .array(measureSchema)
        .length(1)
        .describe("One measure of traces and its aggregation."),
      level: z.enum(GEOGRAPHY_LEVELS).default("world"),
      country: z
        .string()
        .regex(/^[A-Z]{2}$/, "A country is its ISO 3166-1 code of two letters.")
        .optional()
        .describe("The country whose regions are shown."),
      filters: filtersWith({ scorer: scorer.optional() }),
    })
    .superRefine(({ measures: [first], level, country, filters }, context) => {
      if (!first) return;
      const rules: MeasureRules = MEASURES[first.measure];
      const refuse = (message: string, ...path: (string | number)[]) =>
        context.addIssue({ code: "custom", message, path });
      if (!rules.filterable) refuse(`${rules.label} has no location.`, "measures", 0);
      if (level === "country" && !country) refuse("Choose the country.", "country");
      if (level === "world" && country) refuse("The world has no country of its own.", "country");
      if ((filters as { scorer?: unknown }).scorer && !rules.byScorer)
        refuse(`${rules.label} cannot be filtered by scorer.`, "filters", "scorer");
    });
}

function funnelWith<S extends z.ZodType>(scorer: S) {
  const { min, max } = FUNNEL_STEPS;
  const count = `A funnel has ${min} to ${max} steps.`;
  const condition = z.discriminatedUnion(
    "type",
    [
      z.strictObject({ type: z.literal("tool"), name: named("Name the tool of each step.") }),
      z.strictObject({ type: z.literal("skill"), name: named("Name the skill of each step.") }),
      checkSchema,
      z
        .strictObject({
          type: z.literal("scorer"),
          scorer,
          result: z.enum(["passed", "failed"]).optional(),
          atLeast: z.number().min(1).max(5).optional().describe("For a scorer of 1 to 5."),
        })
        .refine(
          ({ result, atLeast }) => (result === undefined) !== (atLeast === undefined),
          "A scorer step takes a result or a least score.",
        ),
      z.strictObject({ type: z.literal("no_error") }),
    ],
    { error: "A step takes a tool, a skill, an attribute, a scorer or no error." },
  );
  return z.strictObject({
    version,
    kind: z.literal("funnel"),
    order: z.enum(FUNNEL_ORDERS).default("in_order"),
    steps: z
      .array(
        z.strictObject({
          name: z
            .string()
            .trim()
            .min(1, "Name each step.")
            .max(MAX_STEP_NAME)
            .refine(hasNoNul, NUL_PROBLEM),
          condition,
        }),
        count,
      )
      .min(min, count)
      .max(max, count),
    filters: traceFilters,
  });
}

function named(message: string) {
  return z.string(message).trim().min(1, message).max(500).refine(hasNoNul, NUL_PROBLEM);
}

function metricQueryWith<S extends z.ZodType>(scorer: S) {
  return z
    .strictObject({
      version,
      kind: z.literal("metric"),
      measures: z.array(measureSchema).length(1).describe("One measure and its aggregation."),
      dimensions: z
        .array(
          z.enum(DIMENSIONS, { error: ({ input }) => `Unknown dimension "${shownValue(input)}".` }),
        )
        .max(MAX_DIMENSIONS, `A query has ${MAX_DIMENSIONS} dimensions at most.`)
        .default([]),
      filters: filtersWith({ scorer: scorer.optional() }),
      bucket: z.enum(BUCKETS).optional().describe("Chosen from the window when absent."),
    })
    .superRefine(({ measures: [first], dimensions, filters, bucket }, context) => {
      if (!first) return;
      const rules: MeasureRules = MEASURES[first.measure];
      const refuse = (message: string, ...path: (string | number)[]) =>
        context.addIssue({ code: "custom", message, path });
      for (const [index, dimension] of dimensions.entries()) {
        if (!rules.dimensions.includes(dimension))
          refuse(`${rules.label} cannot be grouped by "${dimension}".`, "dimensions", index);
        else if (dimensions.indexOf(dimension) !== index)
          refuse(`"${dimension}" is grouped by twice.`, "dimensions", index);
      }
      const { scorer: scorerRef, ...traceFilters } = filters as Record<string, unknown>;
      if (!rules.filterable && !isEmptyFilter(traceFilters))
        refuse(`${rules.label} cannot be filtered.`, "filters");
      if (scorerRef && !rules.byScorer)
        refuse(`${rules.label} cannot be filtered by scorer.`, "filters", "scorer");
      if (bucket && !rules.buckets.includes(bucket))
        refuse(`${rules.label} has no ${bucket} buckets.`, "bucket");
    });
}
