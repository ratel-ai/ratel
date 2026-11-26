/**
 * Every setting and feature flag of the app, read in one place (zfig over zod). A setting comes
 * from the environment, from a JSON config file, or from both: `CONFIG_PATH` names the file, whose
 * shape is the nested keys below (`{ "database": { "url": "..." }, "flags": { "evalGate": true } }`).
 * Precedence: env > file > default. A blank env value reads as unset. An invalid value fails with
 * a `ConfigError` that names the key and its env variable; a `CONFIG_PATH` that names no file fails
 * too. Defaults live in `config-defaults.ts`, which is also the browser's config.
 *
 * Modules read `getConfig()`, never `process.env`, for anything defined here. The exceptions, read
 * where they are used because a framework, a build tool or a third-party SDK owns them:
 * - `NODE_ENV`, `NEXT_RUNTIME` and the other `NEXT_*` variables Next reads;
 * - `next.config.ts` at build time: `RATEL_COMPOSITION` (the `#ee-composition` alias),
 *   `NEXT_DEPLOYMENT_ID`, `BROWSER_SOURCEMAPS`;
 * - variables a third-party SDK reads itself; where the code checks one it reads what the SDK
 *   reads: `PGHOST`/`PGHOSTADDR` (pg, `console/seed/local-database.ts`);
 * - `CONFIG_PATH`, which zfig reads.
 */
import { ConfigError, field, type InferSchema, resolve, schema } from "zfig";
import { z } from "zod";
import { CONFIG_DEFAULTS as D } from "@/config-defaults";
import type { CoreFlag } from "@/lib/contracts/feature-flags";
import { SANDBOX_HARD_LIMITS as HARD } from "@/lib/contracts/usage-limits";

type Env = Readonly<Record<string, string | undefined>>;
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export type Config = InferSchema<typeof CONFIG_SCHEMA>;
export type ConfigOverride = DeepPartial<Config>;
export type ResolveConfigOptions = {
  /** The environment to read; none by default. `CONFIG_PATH` in it names the file. */
  env?: Env;
  /** The config file; `env.CONFIG_PATH` otherwise. */
  configPath?: string;
  /** Values over every source, for tests. */
  override?: ConfigOverride;
};

export { ConfigError };

/** Terraform seeds every human-supplied secret with this until an operator sets it. */
const SECRET_PLACEHOLDER = "REPLACE_ME";
const FLAG_VALUES = 'expected "true", "1", "false" or "0" (any case)';

/** A number above 0. */
const positive = z.number().finite().positive();
/** An integer above 0; a fraction is floored, as the code that read it floored it. */
const positiveCount = positive.transform(Math.floor);
/** A share in (0, 1]. */
const share = positive.max(1);
/** A ratio in [0, 1]. */
const unit = z.number().min(0).max(1);
const nonNegative = z.number().finite().min(0);
/** A whole number of 0 or more; 0 usually turns the thing off. */
const nonNegativeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveInt = nonNegativeInt.min(1);
/** On only for `1`, as the code that read it decided. */
const one = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() === "1" : value),
  z.boolean(),
);
const flagValue = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
    return value;
  },
  z.boolean({ error: FLAG_VALUES }),
);
/** A whole number of 0 or more, lowered to `max`. */
const atMost = (max: number) => nonNegativeInt.transform((value) => Math.min(value, max));
const trimmed = z.string().trim();
const configured = trimmed.transform((value) => (value === SECRET_PLACEHOLDER ? undefined : value));

/** The env variable of each core flag; its file key is `flags.<key>`. */
const FLAG_ENV = {
  evalGate: "FF_EVAL_GATE",
  rankingCatalogDrift: "FF_RANKING_CATALOG_DRIFT",
  mcpApps: "FF_MCP_APPS",
  agentsPages: "FF_AGENTS_PAGES",
  toolRunInsights: "FF_TOOL_RUN_INSIGHTS",
  focusedConsole: "FF_FOCUSED_CONSOLE",
  sandboxes: "FF_SANDBOXES",
  evals: "FF_EVALS",
} as const satisfies Record<CoreFlag, string>;

/** Detector floors that are shares in (0, 1]; every other floor is a number above 0. */
const SHARE_FLOORS: ReadonlySet<string> = new Set([
  "first_try_miss.minLow",
  "buried_tool.minLow",
  "magnet.minTop3Low",
  "magnet.maxHigh",
  "sequence_chain.minConditional",
  "sequence_chain.dependencyShare",
  "sequence_chain.workflowViaSearch",
  "sibling_confusion.minCoHitShare",
  "sibling_confusion.minSplit",
  "error_loop.minLow",
  "no_follow_through.minLow",
  "abandoned_search.minLow",
  "padding_share.minJunkLow",
  "unstable_intent.maxTopShare",
  "repeat_invoke.minLow",
  "fragmented_intents.minLow",
  "tool_switch.minShare",
  "empty_result.minShare",
  "empty_result.minLow",
  "long_turn.minShare",
  "identical_retry.minShare",
  "wait_heavy.minShare",
  "token_heavy.topShare",
  "token_heavy.minTokenShare",
  "system_turn_failing.minLow",
  "agent_failing.minLow",
  "workflow_failing.maxCompletion",
  "workflow_failing.minFailureLow",
  "workflow_fixed_chain.minOrderStability",
  "self_correcting.minLow",
]);

const CONFIG_SCHEMA = schema({
  app: {
    /** The edition this process composes (`lib/composition/ports.ts`). */
    composition: setting("RATEL_COMPOSITION", trimmed, D.app.composition),
    name: setting("APP_NAME", trimmed, D.app.name),
    /** The origin snippets start from (`lib/platform/app-config.ts`). */
    baseUrl: setting("BASE_URL", trimmed, D.app.baseUrl),
    /** The canonical public origin (`lib/platform/public-url.ts`); required outside a local environment. */
    publicUrl: optional("APP_PUBLIC_URL", trimmed),
    environment: setting("APP_ENV", trimmed, D.app.environment),
    organizationName: optional("RATEL_ORG_NAME", trimmed),
    role: setting("APP_ROLE", z.preprocess(lower, z.enum(["all", "api", "worker"])), D.app.role),
  },
  /** Open-source edition only: every experimental flag on. */
  experimentalFeatures: setting("RATEL_EXPERIMENTAL_FEATURES", flagValue, D.experimentalFeatures),
  /** Each core flag: unset is not forced (the edition decides, else off). */
  flags: Object.fromEntries(
    Object.entries(FLAG_ENV).map(([key, env]) => [key, optional(env, flagValue)]),
  ) as { [K in CoreFlag]: ReturnType<typeof optional<typeof flagValue>> },
  database: {
    url: optional("DATABASE_URL", trimmed, { sensitive: true }),
    /** `disable` turns TLS off; unset, TLS except for a localhost URL. */
    ssl: optional("DATABASE_SSL", trimmed),
    poolMax: setting("DATABASE_POOL_MAX", positiveInt, D.database.poolMax),
    connectTimeoutMs: setting(
      "DATABASE_CONNECT_TIMEOUT_MS",
      nonNegativeInt,
      D.database.connectTimeoutMs,
    ),
    queryTimeoutMs: setting("DATABASE_QUERY_TIMEOUT_MS", nonNegativeInt, D.database.queryTimeoutMs),
    /** 0 turns the timeout off. */
    readTimeoutMs: setting("DATABASE_READ_TIMEOUT_MS", nonNegativeInt, D.database.readTimeoutMs),
    supplementaryReadTimeoutMs: setting(
      "DATABASE_SUPPLEMENTARY_READ_TIMEOUT_MS",
      nonNegativeInt,
      D.database.supplementaryReadTimeoutMs,
    ),
    /** Unset: on for the open-source edition, off for the others. */
    migrateOnBoot: optional("DATABASE_MIGRATE_ON_BOOT", flagValue),
    migrationsDir: optional("MIGRATIONS_DIR", trimmed),
  },
  jobs: {
    /** Unset: in process for the open-source edition, external for the others. */
    cron: optional("RATEL_CRON", z.preprocess(lower, z.enum(["inprocess", "external"]))),
    cronSecret: optional("CRON_SECRET", trimmed, { sensitive: true }),
    drainTimeoutMs: setting("CRON_DRAIN_TIMEOUT_MS", nonNegativeInt, D.jobs.drainTimeoutMs),
    /** 0 turns the cap off. */
    runningPerProject: setting(
      "JOBS_RUNNING_PER_PROJECT",
      nonNegativeInt,
      D.jobs.runningPerProject,
    ),
    importsRunInWorker: setting("IMPORTS_RUN_IN_WORKER", one, D.jobs.importsRunInWorker),
    dataRetention: setting("DATA_RETENTION_ENABLED", one, D.jobs.dataRetention),
  },
  logging: {
    /** Unset: `debug` in development, else `info`. */
    level: optional("LOG_LEVEL", trimmed),
  },
  otel: {
    sdkDisabled: setting(
      "OTEL_SDK_DISABLED",
      z.preprocess(
        (value) => (typeof value === "string" ? value.trim().toLowerCase() === "true" : value),
        z.boolean(),
      ),
      D.otel.sdkDisabled,
    ),
    serviceName: setting("OTEL_SERVICE_NAME", trimmed, D.otel.serviceName),
    /** The root sampling ratio, clamped to [0, 1]. */
    tracesSamplerRatio: setting(
      "OTEL_TRACES_SAMPLER_ARG",
      z.number().transform((n) => Math.min(1, Math.max(0, n))),
      D.otel.tracesSamplerRatio,
    ),
    tracesEndpoint: optional("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", trimmed),
    tracesHeaders: optional("OTEL_EXPORTER_OTLP_TRACES_HEADERS", trimmed, { sensitive: true }),
    logsEndpoint: optional("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", trimmed),
    logsHeaders: optional("OTEL_EXPORTER_OTLP_LOGS_HEADERS", trimmed, { sensitive: true }),
    /** Server traces for APM (`lib/platform/otel/server-traces.ts`). */
    serverTraces: {
      endpoint: optional("OTEL_EXPORTER_OTLP_ENDPOINT", trimmed),
      headers: optional("OTEL_EXPORTER_OTLP_HEADERS", trimmed, { sensitive: true }),
      resourceAttributes: optional("SERVER_TRACES_RESOURCE_ATTRIBUTES", trimmed),
    },
    spanRetentionDays: setting("OTEL_SPAN_RETENTION_DAYS", positiveInt, D.otel.spanRetentionDays),
    /** Unset: the span retention. */
    logRetentionDays: optional("OTEL_LOG_RETENTION_DAYS", positiveInt),
  },
  /** Ratel's own model calls and MCP tool calls as telemetry. */
  selfTelemetry: {
    apiKey: optional("RATEL_SELF_TELEMETRY_API_KEY", configured, { sensitive: true }),
    mcpApiKey: optional("RATEL_SELF_TELEMETRY_MCP_API_KEY", configured, { sensitive: true }),
    endpoint: optional("RATEL_SELF_TELEMETRY_ENDPOINT", configured),
    /** The project those calls write to, whose own analysis is not exported. */
    projectId: optional("RATEL_SELF_TELEMETRY_PROJECT_ID", configured),
  },
  ingest: {
    publishableKeyLimitPerMinute: setting(
      "RATEL_PUBLISHABLE_KEY_LIMIT_PER_MINUTE",
      positiveInt,
      D.ingest.publishableKeyLimitPerMinute,
    ),
    publishableSourceLimitPerMinute: setting(
      "RATEL_PUBLISHABLE_SOURCE_LIMIT_PER_MINUTE",
      positiveInt,
      D.ingest.publishableSourceLimitPerMinute,
    ),
    /** Unset: the request limit times the items one request may carry. */
    publishableKeyItemsPerMinute: optional("RATEL_PUBLISHABLE_KEY_ITEMS_PER_MINUTE", positiveInt),
    publishableSourceItemsPerMinute: optional(
      "RATEL_PUBLISHABLE_SOURCE_ITEMS_PER_MINUTE",
      positiveInt,
    ),
    /** One in N; 0 or less turns sampling off. */
    successSampleRate: setting(
      "OBS_INGEST_SUCCESS_SAMPLE_RATE",
      z.number().int(),
      D.ingest.successSampleRate,
    ),
    rejectionSampleRate: setting(
      "OBS_INGEST_REJECTION_SAMPLE_RATE",
      z.number().int(),
      D.ingest.rejectionSampleRate,
    ),
    /** Stored raw OTLP bytes one project may add per UTC day; 0 stores nothing. */
    otlpRawDailyBytes: setting("OTLP_RAW_DAILY_BYTES", nonNegativeInt, D.ingest.otlpRawDailyBytes),
    otlpRawRetentionDays: setting(
      "OTLP_RAW_RETENTION_DAYS",
      positive,
      D.ingest.otlpRawRetentionDays,
    ),
  },
  anthropic: {
    /** `bedrock`, or unset for the API; any other value turns Claude off. */
    backend: optional("ANTHROPIC_BACKEND", configured),
    apiKey: optional("ANTHROPIC_API_KEY", configured, { sensitive: true }),
    /** Comma-separated Bedrock model ids this account has not enabled. */
    bedrockModelsNotEnabled: optional("BEDROCK_MODELS_NOT_ENABLED", configured),
    /**
     * A long-term Bedrock key. The AWS SDK reads the variable itself; the app reads it only to
     * refuse a Bedrock client, so the calls stay signed by the credential chain (the task role).
     */
    bedrockBearerToken: optional("AWS_BEARER_TOKEN_BEDROCK", configured, { sensitive: true }),
  },
  openai: {
    apiKey: optional("OPENAI_API_KEY", configured, { sensitive: true }),
    baseUrl: optional("OPENAI_BASE_URL", configured),
    embeddingModel: optional("OPENAI_EMBEDDING_MODEL", configured),
    decisionsModel: optional("OPENAI_DECISIONS_MODEL", configured),
    /** The decision engine asked for; this edition has one. */
    decisionEngine: optional("DECISION_ENGINE", configured),
  },
  /** Model overrides; unset, each job uses its own default. */
  models: {
    analyst: optional("ANTHROPIC_MODEL", trimmed),
    traceWorkflowLabel: optional("TRACE_WORKFLOW_LABEL_MODEL", trimmed),
    topicsLabel: optional("TOPICS_LABEL_MODEL", trimmed),
    intentEngineName: optional("INTENT_ENGINE_NAME_MODEL", trimmed),
  },
  evalGate: {
    /** Local environments only: stand-in models instead of Claude. */
    mockModel: setting("EVAL_GATE_MOCK_MODEL", one, D.evalGate.mockModel),
    replayModel: optional("EVAL_GATE_REPLAY_MODEL", configured),
    judgeModel: optional("EVAL_GATE_JUDGE_MODEL", configured),
    /** Local environments only. */
    replayModelOverride: optional("EVAL_GATE_REPLAY_MODEL_OVERRIDE", configured),
    draftModel: optional("EVAL_GATE_DRAFT_MODEL", trimmed),
    replayBudgetUsd: setting(
      "EVAL_GATE_REPLAY_BUDGET_USD",
      nonNegative,
      D.evalGate.replayBudgetUsd,
    ),
    judgeBudgetUsd: setting("EVAL_GATE_JUDGE_BUDGET_USD", nonNegative, D.evalGate.judgeBudgetUsd),
    replayMaxSteps: setting(
      "EVAL_GATE_REPLAY_MAX_STEPS",
      z.number().finite().min(1).transform(Math.floor),
      D.evalGate.replayMaxSteps,
    ),
    taskJudgeSample: setting(
      "TASK_JUDGE_SAMPLE",
      nonNegative.transform(Math.floor),
      D.evalGate.taskJudgeSample,
    ),
    taskJudgeBudgetUsd: setting(
      "TASK_JUDGE_BUDGET_USD",
      nonNegative,
      D.evalGate.taskJudgeBudgetUsd,
    ),
  },
  matchQuality: {
    /** Local environments only. */
    mockAnalyst: setting("MATCH_QUALITY_MOCK_ANALYST", one, D.matchQuality.mockAnalyst),
    /** Capped at 30 s. */
    mockDelayMs: setting("MATCH_QUALITY_MOCK_DELAY_MS", nonNegative, D.matchQuality.mockDelayMs),
  },
  traceTurns: {
    inferredGapMs: setting("TRACE_TURNS_INFERRED_GAP_MS", positive, D.traceTurns.inferredGapMs),
    stepCap: setting("TRACE_TURNS_STEP_CAP", positiveCount, D.traceTurns.stepCap),
    durationCapMs: setting("TRACE_TURNS_DURATION_CAP_MS", positive, D.traceTurns.durationCapMs),
    idleCloseMs: setting("TRACE_TURNS_IDLE_CLOSE_MS", positive, D.traceTurns.idleCloseMs),
    gatewayDedupeMs: setting(
      "TRACE_TURNS_GATEWAY_DEDUPE_MS",
      positive,
      D.traceTurns.gatewayDedupeMs,
    ),
    pairingWindowMs: setting(
      "TRACE_TURNS_PAIRING_WINDOW_MS",
      positive,
      D.traceTurns.pairingWindowMs,
    ),
  },
  traceSignals: {
    /** The salt of every stored query hash; required outside a local environment. */
    hashSalt: optional("TRACE_SIGNALS_HASH_SALT", configured, { sensitive: true }),
    sameAskJaccard: setting("TRACE_SIGNALS_SAME_ASK_JACCARD", share, D.traceSignals.sameAskJaccard),
    askedAgainGapMs: setting(
      "TRACE_SIGNALS_ASKED_AGAIN_GAP_MS",
      positive,
      D.traceSignals.askedAgainGapMs,
    ),
    askedAgainTextJaccard: setting(
      "TRACE_SIGNALS_ASKED_AGAIN_TEXT_JACCARD",
      share,
      D.traceSignals.askedAgainTextJaccard,
    ),
    pairToolMinTurns: setting(
      "TRACE_SIGNALS_PAIR_TOOL_MIN_TURNS",
      positiveCount,
      D.traceSignals.pairToolMinTurns,
    ),
    maxQueryHashes: setting(
      "TRACE_SIGNALS_MAX_QUERY_HASHES",
      positiveCount,
      D.traceSignals.maxQueryHashes,
    ),
    windowDays: setting("TRACE_SIGNALS_WINDOW_DAYS", positiveCount, D.traceSignals.windowDays),
    timeBudgetMs: setting("TRACE_SIGNALS_TIME_BUDGET_MS", positive, D.traceSignals.timeBudgetMs),
    maxLinkRows: setting("TRACE_SIGNALS_MAX_LINK_ROWS", positiveCount, D.traceSignals.maxLinkRows),
    maxOtelRows: setting("TRACE_SIGNALS_MAX_OTEL_ROWS", positiveCount, D.traceSignals.maxOtelRows),
    prereqWindowMs: setting("PREREQ_WINDOW_MS", positive, D.traceSignals.prereqWindowMs),
    maxWorkflowTurns: setting(
      "TRACE_SIGNALS_MAX_WORKFLOW_TURNS",
      positiveCount,
      D.traceSignals.maxWorkflowTurns,
    ),
    minExactRuns: setting(
      "TRACE_SIGNALS_MIN_EXACT_RUNS",
      positiveCount,
      D.traceSignals.minExactRuns,
    ),
    minInferredForMix: setting(
      "TRACE_SIGNALS_MIN_INFERRED_FOR_MIX",
      positiveCount,
      D.traceSignals.minInferredForMix,
    ),
    mixedCapShare: setting("TRACE_SIGNALS_MIXED_CAP_SHARE", positive, D.traceSignals.mixedCapShare),
    /** Each detector's floors: `TRACE_SIGNALS_<KIND>_<FLOOR>`, `traceSignals.floors.<kind>.<floor>`. */
    floors: floorSettings(D.traceSignals.floors),
  },
  traceWorkflows: {
    maxAsks: setting("TRACE_WORKFLOW_MAX_ASKS", positiveCount, D.traceWorkflows.maxAsks),
    /** The decide job's input-token cap; unset, `maxJudgeTokens`. */
    maxJevTokens: optional("TRACE_WORKFLOW_MAX_JEV_TOKENS", positive),
    maxJudgeTokens: setting(
      "TRACE_WORKFLOW_MAX_JUDGE_TOKENS",
      positive,
      D.traceWorkflows.maxJudgeTokens,
    ),
    maxLabels: setting("TRACE_WORKFLOW_MAX_LABELS", positiveCount, D.traceWorkflows.maxLabels),
  },
  intentEngine: {
    strong: setting("RATEL_INTENT_ENGINE_STRONG", unit, D.intentEngine.strong),
    weak: setting("RATEL_INTENT_ENGINE_WEAK", unit, D.intentEngine.weak),
    tools: setting("RATEL_INTENT_ENGINE_TOOLS", unit, D.intentEngine.tools),
    margin: setting("RATEL_INTENT_ENGINE_MARGIN", unit, D.intentEngine.margin),
    /** Clusters one run names at most; 0 turns naming off. */
    maxNames: setting(
      "INTENT_ENGINE_MAX_NAMES",
      nonNegative.transform(Math.floor),
      D.intentEngine.maxNames,
    ),
    bm25Threshold: setting("RATEL_INTENT_BM25_THRESHOLD", unit, D.intentEngine.bm25Threshold),
    bm25Margin: setting("RATEL_INTENT_BM25_MARGIN", unit, D.intentEngine.bm25Margin),
  },
  queryIntents: {
    triggerCount: setting("QUERY_INTENTS_TRIGGER_COUNT", positiveInt, D.queryIntents.triggerCount),
  },
  toolExplorer: {
    maxEdgeRows: setting("TOOL_EXPLORER_MAX_EDGE_ROWS", positiveCount, D.toolExplorer.maxEdgeRows),
    maxSetRows: setting("TOOL_EXPLORER_MAX_SET_ROWS", positiveCount, D.toolExplorer.maxSetRows),
    timeBudgetMs: setting("TOOL_EXPLORER_TIME_BUDGET_MS", positive, D.toolExplorer.timeBudgetMs),
    windowDays: setting("TOOL_EXPLORER_WINDOW_DAYS", positiveCount, D.toolExplorer.windowDays),
    minSetSupport: setting(
      "TOOL_EXPLORER_MIN_SET_SUPPORT",
      positiveCount,
      D.toolExplorer.minSetSupport,
    ),
    minSetShare: setting("TOOL_EXPLORER_MIN_SET_SHARE", share, D.toolExplorer.minSetShare),
    maxSetCandidates: setting(
      "TOOL_EXPLORER_MAX_SET_CANDIDATES",
      positiveCount,
      D.toolExplorer.maxSetCandidates,
    ),
    minIntentUnits: setting(
      "TOOL_EXPLORER_MIN_INTENT_UNITS",
      positiveCount,
      D.toolExplorer.minIntentUnits,
    ),
    intentGroupRelevance: setting(
      "TOOL_EXPLORER_INTENT_GROUP_RELEVANCE",
      share,
      D.toolExplorer.intentGroupRelevance,
    ),
    maxSessions: setting("TOOL_EXPLORER_MAX_SESSIONS", positiveCount, D.toolExplorer.maxSessions),
    maxCallsPerSession: setting(
      "TOOL_EXPLORER_MAX_CALLS_PER_SESSION",
      positiveCount,
      D.toolExplorer.maxCallsPerSession,
    ),
  },
  sandboxes: {
    /** Seals sandbox secrets: 32 random bytes in base64 (`lib/platform/sealed-secrets.ts`). */
    secretsKey: optional("SANDBOX_SECRETS_KEY", configured, { sensitive: true }),
    /**
     * The VM service: `boat`, or `local-docker` (the local Docker daemon, for development and proof
     * only: refused in production and in the Cloud composition). Unset: `boat` when its key is set.
     */
    provider: optional("SANDBOX_PROVIDER", z.preprocess(lower, z.enum(["boat", "local-docker"]))),
    /** The API key of the VM service. With none, Ratel sandbox shows "not configured". */
    boatApiKey: optional("BOAT_API_KEY", configured, { sensitive: true }),
    /** The base URL of the API of the VM service. */
    boatApiUrl: setting("BOAT_API_URL", trimmed, D.sandboxes.boatApiUrl),
    /** The machine size of each VM. */
    boatVmType: setting(
      "BOAT_VM_TYPE",
      z.enum(["small", "default", "large", "xlarge"]),
      D.sandboxes.boatVmType,
    ),
    /**
     * The label of each VM this deployment starts. The sweep deletes only VMs with this label, so
     * deployments that share one VM service account do not delete the VMs of each other. Unset: a
     * hash of the public URL, else of the base URL (`sandboxDeploymentId`).
     */
    deploymentId: optional(
      "SANDBOX_DEPLOYMENT_ID",
      z
        .string()
        .trim()
        .regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    ),
    /** The address at which an instance reaches this deployment; the public URL when unset. */
    callbackUrl: optional("SANDBOX_CALLBACK_URL", trimmed),
    /** The folder of the pushed bundles; a folder of the system's temporary folder when unset. */
    bundleDir: optional("SANDBOX_BUNDLE_DIR", trimmed),
    /**
     * Each project's limits, and the VM start budgets of an organization and of the provider account.
     * A value above the hard limit counts as the hard limit.
     */
    limits: {
      sandbox_concurrent_instances: setting(
        "SANDBOX_CONCURRENT_INSTANCES",
        atMost(HARD.sandbox_concurrent_instances),
        D.sandboxes.limits.sandbox_concurrent_instances,
      ),
      sandbox_run_seconds: setting(
        "SANDBOX_RUN_SECONDS",
        atMost(HARD.sandbox_run_seconds),
        D.sandboxes.limits.sandbox_run_seconds,
      ),
      sandbox_runs_per_day: setting(
        "SANDBOX_RUNS_PER_DAY",
        atMost(HARD.sandbox_runs_per_day),
        D.sandboxes.limits.sandbox_runs_per_day,
      ),
      sandbox_versions_per_day: setting(
        "SANDBOX_VERSIONS_PER_DAY",
        atMost(HARD.sandbox_versions_per_day),
        D.sandboxes.limits.sandbox_versions_per_day,
      ),
      sandbox_bundle_bytes: setting(
        "SANDBOX_BUNDLE_BYTES",
        atMost(HARD.sandbox_bundle_bytes),
        D.sandboxes.limits.sandbox_bundle_bytes,
      ),
      sandbox_vm_starts_per_day: setting(
        "SANDBOX_VM_STARTS_PER_DAY",
        atMost(HARD.sandbox_vm_starts_per_day),
        D.sandboxes.limits.sandbox_vm_starts_per_day,
      ),
      sandbox_org_vm_starts_per_day: setting(
        "SANDBOX_ORG_VM_STARTS_PER_DAY",
        atMost(HARD.sandbox_org_vm_starts_per_day),
        D.sandboxes.limits.sandbox_org_vm_starts_per_day,
      ),
      sandbox_account_vm_starts_per_minute: setting(
        "SANDBOX_ACCOUNT_VM_STARTS_PER_MINUTE",
        atMost(HARD.sandbox_account_vm_starts_per_minute),
        D.sandboxes.limits.sandbox_account_vm_starts_per_minute,
      ),
      sandbox_account_vm_starts_per_hour: setting(
        "SANDBOX_ACCOUNT_VM_STARTS_PER_HOUR",
        atMost(HARD.sandbox_account_vm_starts_per_hour),
        D.sandboxes.limits.sandbox_account_vm_starts_per_hour,
      ),
      sandbox_account_vm_starts_per_day: setting(
        "SANDBOX_ACCOUNT_VM_STARTS_PER_DAY",
        atMost(HARD.sandbox_account_vm_starts_per_day),
        D.sandboxes.limits.sandbox_account_vm_starts_per_day,
      ),
    },
    /** A run VM with no run for this time is deleted. */
    vmIdleSeconds: setting("SANDBOX_VM_IDLE_SECONDS", positiveCount, D.sandboxes.vmIdleSeconds),
  },
  topics: {
    maxTurns: setting("TOPICS_MAX_TURNS", positiveCount, D.topics.maxTurns),
    newMinTurns: setting("TOPICS_NEW_MIN_TURNS", positiveCount, D.topics.newMinTurns),
    maxJudgedAsks: setting("TOPICS_MAX_JUDGED_ASKS", positiveCount, D.topics.maxJudgedAsks),
    maxSentimentAsks: setting(
      "TOPICS_MAX_SENTIMENT_ASKS",
      positiveCount,
      D.topics.maxSentimentAsks,
    ),
    maxJudgeTokens: setting("TOPICS_MAX_JUDGE_TOKENS", positiveCount, D.topics.maxJudgeTokens),
  },
});

let memoized: Config | undefined;

/**
 * The settings from `options.env` (none by default) and the config file it or `options.configPath`
 * names. Pure: for tests and scripts. Throws a `ConfigError` on an invalid value.
 */
export function resolveConfig(options: ResolveConfigOptions = {}): Config {
  try {
    return resolve(CONFIG_SCHEMA, {
      env: { ...options.env },
      ...(options.configPath ? { configPath: options.configPath } : {}),
      ...(options.override ? { override: options.override } : {}),
    });
  } catch (error) {
    throw error instanceof ConfigError ? withEnvName(error) : error;
  }
}

/** This process's settings: `process.env` and the `CONFIG_PATH` file, read once. */
export function getConfig(): Config {
  memoized ??= resolveConfig({ env: process.env });
  return memoized;
}

/** Tests only: the next `getConfig()` reads the environment again. */
export function resetConfigForTests(): void {
  memoized = undefined;
}

/** A setting with a default: a blank value reads as the default. */
function setting<T extends z.ZodType>(env: string, type: T, fallback: unknown) {
  return field({
    type: z.preprocess((value) => (isBlank(value) ? fallback : toInput(type, value)), type),
    env,
    default: fallback,
  });
}

/** A setting without a default: unset (or blank) reads as undefined. */
function optional<T extends z.ZodType>(
  env: string,
  type: T,
  options: { sensitive?: boolean } = {},
) {
  return field({
    type: z.preprocess(
      (value) => (isBlank(value) ? undefined : toInput(type, value)),
      type.optional(),
    ),
    env,
    // zfig asks for a value or a default; null stands for "unset" and reads as undefined.
    default: null,
    ...options,
  });
}

/** Every detector floor as a setting, from its default; see `SHARE_FLOORS`. */
function floorSettings<F extends Record<string, Record<string, number>>>(defaults: F) {
  return Object.fromEntries(
    Object.entries(defaults).map(([kind, floors]) => [
      kind,
      Object.fromEntries(
        Object.entries(floors).map(([name, fallback]) => [
          name,
          setting(
            `TRACE_SIGNALS_${kind.toUpperCase()}_${snakeCase(name)}`,
            SHARE_FLOORS.has(`${kind}.${name}`) ? share : positive,
            fallback,
          ),
        ]),
      ),
    ]),
  ) as { [K in keyof F]: { [N in keyof F[K]]: ReturnType<typeof setting<typeof positive>> } };
}

function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

function isBlank(value: unknown): boolean {
  return (
    value === null || value === undefined || (typeof value === "string" && value.trim() === "")
  );
}

/** An env string as the number a numeric setting wants; anything else as it is. */
function toInput(type: z.ZodType, value: unknown): unknown {
  return typeof value === "string" && wantsNumber(type) ? toNumber(value) : value;
}

function wantsNumber(type: z.ZodType): boolean {
  const def = type._zod.def as { type: string; in?: z.ZodType };
  if (def.type === "number") return true;
  return def.type === "pipe" && def.in !== undefined && wantsNumber(def.in);
}

function toNumber(value: unknown): unknown {
  return typeof value === "string" ? Number(value.trim()) : value;
}

function lower(value: unknown): unknown {
  return typeof value === "string" ? value.trim().toLowerCase() : value;
}

/** The zfig error, with the env variable that sets the key and where the bad value came from. */
function withEnvName(error: ConfigError): ConfigError {
  const decision = error.diagnostics?.findLast(
    (event) => event.type === "sourceDecision" && event.key === error.path,
  );
  if (decision?.type !== "sourceDecision") return error;
  const env = decision.tried.find((source) => source.startsWith("env:"))?.slice("env:".length);
  if (!env) return error;
  const message = `${error.message}. Set it with the ${env} environment variable or "${error.path}" in the config file (this value came from ${decision.picked}).`;
  return new ConfigError(message, error.path, error.sensitive, error.diagnostics);
}
