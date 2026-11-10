/**
 * The inputs both editions are given (temporary parity harness, RTL-45). Plain data and nothing
 * else: `scripts/platform-parity/capture.mts` feeds these to Ratel Cloud's code and writes what
 * it answers under `golden/`; the `*.parity.test.ts` files feed the same values to this
 * repository's code and compare. No import from either application belongs here.
 */

export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
export const ORGANIZATION_SLUG = "acme";

/** The three shells a reader can be in. */
export const NAV_SCOPES = ["project", "project+stageSpine", "organization"] as const;
export type NavScope = (typeof NAV_SCOPES)[number];

/** Paths under the project root whose rail item is asked for, with the stage spine off and on. */
export const PROJECT_PATHS = [
  "",
  "/dashboards",
  "/insights",
  "/health",
  "/health/tasks",
  "/health/tasks/sessions/s-1",
  "/health/self-corrections",
  "/improvement/health",
  "/improvement/tool-explorer",
  "/improvement/tool-explorer/suggestions",
  "/traces",
  "/traces/0123456789abcdef",
  "/catalogs",
  "/catalogs/tools",
  "/catalogs/skills/refunds",
  "/playground",
  "/intents",
  "/intents/asks",
  "/intents/flows",
  "/intents/map",
  "/improvement",
  "/improvement/fixes",
  "/improvement/fixes/f-1",
  "/quality",
  "/calibration",
  "/calibration/exp-1",
  "/improvement/match-quality",
  "/improvement/adaptive-ranking",
  "/settings",
  "/settings/api-keys",
  "/runtime-events",
  "/tasks",
  "/tasks/t-1",
  "/ship",
  "/nowhere",
] as const;

/** Paths under the organization root. */
export const ORGANIZATION_PATHS = ["", "/mcp", "/settings", "/nowhere"] as const;

/** What a person types into ⌘K. */
export const COMMAND_QUERIES = [
  "api keys",
  "danger",
  "delete project",
  "experiments",
  "calibration",
  "sdk events",
  "usage",
  "spend",
  "tokens",
  "retries",
  "playground",
  "mcp",
  "shipped",
  "workflows",
  "home",
  "rewrite",
  "unanswered",
  "signals",
  "runs",
  "fixes",
] as const;

/** Old addresses the shared legacy rule answers; no project slug resolves. */
export const LEGACY_ADDRESSES = [
  "/dashboard",
  "/dashboard?range=7d",
  "/dashboard/usage?range=7d",
  "/traces",
  "/traces/events",
  "/traces/abc?tab=logs",
  "/explore",
  "/explore?tab=intents&intentsPage=2",
  "/explore?tab=suggestions&sstatus=open",
  "/experiments",
  "/experiments/exp-1",
  "/settings",
  "/nothing-here",
] as const;

/** `/dashboard` as a person with a bookmark reaches it: an unknown project slug and a range. */
export const DASHBOARD_REQUEST = { project: "ghost", range: "7d" } as const;

/** Source ids asked "is this an Agent health import?". */
export const SOURCE_IDS = [
  "langfuse-import",
  "langsmith-import",
  "postgres-import",
  "csv-import",
  "my-agent-import",
  "-import",
  "import",
  "LANGFUSE-IMPORT",
  "langfuse-import ",
  "site-copilot",
  "",
  null,
] as const;

/** Environments the self-telemetry configuration is resolved for. */
export const TELEMETRY_ENVIRONMENTS: readonly {
  name: string;
  deploymentEnvironment: string;
  env: Record<string, string>;
}[] = [
  {
    name: "both endpoints set",
    deploymentEnvironment: "production",
    env: {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://otel.example.com/v1/traces",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://otel.example.com/v1/logs",
    },
  },
  {
    name: "both endpoints with headers and a sampler ratio",
    deploymentEnvironment: "staging",
    env: {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://otel.example.com/v1/traces",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=Bearer t,x-team=a",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://otel.example.com/v1/logs",
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: "authorization=Bearer l",
      OTEL_TRACES_SAMPLER_ARG: "0.25",
    },
  },
  {
    name: "the emergency stop",
    deploymentEnvironment: "production",
    env: {
      OTEL_SDK_DISABLED: "true",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://otel.example.com/v1/traces",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://otel.example.com/v1/logs",
    },
  },
];

/** What a project's quickstart is built for. */
export const QUICKSTART_TARGET = {
  endpoint: "https://ratel.example.com/v1/traces",
  serviceName: "site-copilot",
} as const;

/** The Site Copilot seed, pinned: the same plan and the same instant on both sides. */
export const SEED = { seed: 20261109, turns: 400, anchor: "2026-11-09T10:00:00.000Z" } as const;

/** What one model round trip costs the Fixes project, and what its tasks used. */
export const FIXES_PRICE = {
  ms: 100,
  usd: 0.01,
  inputTokens: 200,
  outputTokens: 50,
  modelCalls: 100,
};
export const FIXES_TASK_USAGE: readonly [
  string,
  { windowDays: number; tokens: number; usd: number; ms: number },
][] = [
  ["wf_assign", { windowDays: 30, tokens: 120_000, usd: 4.8, ms: 96_000 }],
  ["wf_order", { windowDays: 30, tokens: 40_000, usd: 1.6, ms: 32_000 }],
  ["wf_notify", { windowDays: 30, tokens: 9_000, usd: 0.4, ms: 6_000 }],
  ["wf_rare", { windowDays: 30, tokens: 600, usd: 0.02, ms: 400 }],
];
export const FIXES_WINDOW_DAYS = 30;

/** A stored replay that came out worse: the whole interval is below zero. */
export const WORSE_BACKTEST = {
  scorer: "bm25-craft-replay",
  n: 20,
  affectedN: 8,
  before: { contained: 15 },
  after: { contained: 11 },
  delta: { quality: -0.2, interval: { low: -0.32, high: -0.08 } },
  mapping: {},
  caveats: [],
} as const;

/** Measured totals scaled to a period, and a fix's gain told as savings. */
export const SAVINGS = [
  { savings: { tokens: 30_000, usd: 3, ms: 90_000 }, windowDays: 30 },
  { savings: { tokens: 30_000, usd: 3, ms: 90_000 }, windowDays: 10 },
  { savings: { tokens: 1_200, usd: null, ms: null }, windowDays: 7 },
  { savings: { tokens: 500, usd: 0.5, ms: 500 }, windowDays: null },
  { savings: { tokens: 500, usd: 0.5, ms: 500 }, windowDays: 0 },
] as const;
export const GAINS = [
  null,
  { windowDays: 30, roundTrips: 40, calls: 40, tokens: 10_000, usd: 0.4, ms: 4_000 },
  { windowDays: 10, roundTrips: 40, calls: 40, tokens: 10_000, usd: 0.4, ms: 4_000 },
  { windowDays: 30, roundTrips: 6, calls: 6, tokens: null, usd: null, ms: 50_000 },
  { windowDays: null, roundTrips: 6, calls: 6, tokens: 900, usd: 0.1, ms: 600 },
  { windowDays: 30, roundTrips: 0, calls: 0, tokens: null, usd: null, ms: null },
] as const;
export const SAVINGS_PERIOD_KEYS = ["day", "week", "month"] as const;
