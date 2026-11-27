import type { Config } from "@/config";
import { SANDBOX_HARD_LIMITS } from "@/lib/contracts/usage-limits";
import { WORKFLOW_THRESHOLDS as WF } from "@/lib/readings/trace-signals/workflows/detect";

/**
 * The default of every setting that has one, by its key in `config.ts` (the schema, the env
 * names and the parsing rules live there). A setting absent here is unset by default.
 *
 * Also the browser's config. A browser has no environment and no config file, and `config.ts`
 * reads files, so the browser bundles (Next's client, `next.config.ts`; the MCP Apps views,
 * `mcp-apps/scripts/build.mts`) resolve `@/config` to this module: code shared with the browser
 * reads the defaults there, as it read an empty `process.env` before. Keep it a leaf: it imports
 * no module that reads the config.
 */
export const CONFIG_DEFAULTS = {
  app: {
    composition: "oss",
    name: "Ratel",
    baseUrl: "http://localhost:3000",
    environment: "development",
    role: "all",
  },
  experimentalFeatures: false,
  flags: {},
  database: {
    poolMax: 10,
    connectTimeoutMs: 15_000,
    queryTimeoutMs: 120_000,
    readTimeoutMs: 15_000,
    supplementaryReadTimeoutMs: 5_000,
  },
  jobs: {
    drainTimeoutMs: 10 * 60 * 1000,
    runningPerProject: 1,
    importsRunInWorker: false,
    dataRetention: false,
  },
  logging: {},
  otel: {
    sdkDisabled: false,
    serviceName: "ratel-platform",
    tracesSamplerRatio: 1,
    spanRetentionDays: 30,
    serverTraces: {},
  },
  selfTelemetry: {},
  ingest: {
    publishableKeyLimitPerMinute: 6_000,
    publishableSourceLimitPerMinute: 120,
    successSampleRate: 100,
    rejectionSampleRate: 100,
    otlpRawDailyBytes: 1024 ** 3,
    otlpRawRetentionDays: 30,
    experimentalQueue: false,
    persistPerProject: 1,
    persistConcurrency: 2,
    batchMaxAttempts: 5,
  },
  anthropic: {},
  openai: {},
  slack: { url: "https://slack.com" },
  models: {},
  evalGate: {
    mockModel: false,
    replayBudgetUsd: 1,
    judgeBudgetUsd: 0.1,
    replayMaxSteps: 8,
    taskJudgeSample: 20,
    taskJudgeBudgetUsd: 0.5,
  },
  matchQuality: { mockAnalyst: false, mockDelayMs: 1_500 },
  traceTurns: {
    inferredGapMs: 90_000,
    stepCap: 40,
    durationCapMs: 15 * 60_000,
    idleCloseMs: 30 * 60_000,
    gatewayDedupeMs: 2_000,
    pairingWindowMs: 10 * 60_000,
  },
  traceSignals: {
    sameAskJaccard: 0.5,
    askedAgainGapMs: 10 * 60_000,
    askedAgainTextJaccard: 0.8,
    askedAgainMinWords: 3,
    fanOutGapMs: 250,
    pairToolMinTurns: 20,
    maxQueryHashes: 20_000,
    windowDays: 30,
    timeBudgetMs: 6 * 60_000,
    maxLinkRows: 100_000,
    maxOtelRows: 1_000_000,
    prereqWindowMs: 10 * 60_000,
    maxWorkflowTurns: 100_000,
    minExactRuns: 30,
    minInferredForMix: 20,
    mixedCapShare: 0.25,
    floors: {
      first_try_miss: { minN: 10, minK: 3, minLow: 0.15 },
      // Picked from below the top 5 (RC-226): within it the agent reads the list and picks well.
      buried_tool: { minN: 10, minK: 3, minRank: 6, minLow: 0.3 },
      // Listings at #1 to #3, the slots a magnet takes from the right tool: a count of them, and a
      // lower bound on the share of searches whose top three it took. A tool that only pads the
      // tail of long lists is not a magnet.
      magnet: {
        minImpressions: 50,
        minTop3Impressions: 20,
        minTop3Low: 0.05,
        maxHigh: 0.03,
        maxPicks: 4,
      },
      dead_tool: { minLedgerDays: 14, minTurns: 200 },
      sequence_chain: {
        minPairs: 10,
        minLift: 3,
        minConditional: 0.4,
        dependencyShare: 0.8,
        workflowViaSearch: 0.5,
        // The card says the two "always run together": at least this share of the turns of one
        // of them must hold the pair (one MCP server's reading showed 7%).
        alwaysShare: 0.75,
      },
      sibling_confusion: { minCoHitShare: 0.3, minSwaps: 5, minSplit: 0.2 },
      error_loop: { minErrors: 5, minLoopTurns: 3, minLow: 0.2 },
      no_follow_through: { minN: 10, minK: 3, withinMs: 30_000, minLow: 0.1 },
      abandoned_search: { minTurns: 30, minLow: 0.1 },
      padding_share: {
        minSearches: 100,
        maxPickRankP95: 3,
        minMedianTopK: 8,
        minJunkLow: 0.5,
        pickCutoff: 5,
      },
      latency_outlier: { minN: 20, minP95Ms: 10_000, medianMultiple: 5 },
      unstable_intent: { minN: 8, minDistinct: 3, maxTopShare: 0.5 },
      repeat_invoke: { minN: 10, minK: 3, minCalls: 3, minLow: 0.1 },
      fragmented_intents: { minClusters: 20, minLow: 0.5 },
      cooccurring_intents: {},
      // The OTel kinds (`detect-otel.ts`) read OTLP-lane turns only. tool_switch: turns where a
      // failed or empty call of A was followed at once by a good call of B, and their share of the
      // OTel turns that call A.
      tool_switch: { minTurns: 10, minShare: 0.2 },
      empty_result: { minCaptured: 20, minShare: 0.4, minLow: 0.3 },
      unknown_tool: { minCalls: 5 },
      unused_tool: { minModelCalls: 50, minTurns: 20 },
      // A long turn makes at least max(minCalls, medianMultiple x median) model calls. A tool is
      // named when it shows up in minToolTurns long turns and minToolRatio times more often there
      // than in turns overall.
      long_turn: {
        minCalls: 8,
        medianMultiple: 3,
        minTurns: 10,
        minShare: 0.05,
        minToolTurns: 3,
        minToolRatio: 1.5,
      },
      blocked_action: { minCalls: 3, minTurns: 2 },
      identical_retry: { minTurns: 3, minShare: 0.2 },
      wait_heavy: { minCalls: 10, minShare: 0.15, minMedianMs: 10_000 },
      token_heavy: { minTurns: 30, topShare: 0.05, minTokenShare: 0.4, minRatio: 5 },
      system_turn_failing: { minTurns: 20, minLow: 0.1, minRatio: 2 },
      agent_failing: { minCalls: 30, minLow: 0.05, minRatio: 2 },
      workflow_failing: {
        minRuns: WF.failing.minRuns,
        maxCompletion: WF.failing.maxCompletion,
        minFailureLow: WF.failing.minFailureLow,
      },
      workflow_slow: {
        minRuns: WF.slow.minRuns,
        minRatio: WF.slow.minRatio,
        minMedianMs: WF.slow.minMedianMs,
      },
      workflow_fixed_chain: {
        minRuns: WF.fixedChain.minRuns,
        minCoreSize: WF.fixedChain.minCoreSize,
        minOrderStability: WF.fixedChain.minOrderStability,
      },
      // A tool or task (`self-corrections/issues.ts`): of its turns, those with a self-correction.
      self_correcting: { minN: 20, minK: 5, minLow: 0.1 },
    },
  },
  traceWorkflows: { maxAsks: 300, maxJudgeTokens: 3_000_000, maxLabels: 30 },
  intentEngine: {
    strong: 0.6,
    weak: 0.3,
    tools: 0.5,
    margin: 0.1,
    maxNames: 20,
    bm25Threshold: 0.6,
    bm25Margin: 0.1,
  },
  queryIntents: { triggerCount: 40 },
  toolExplorer: {
    maxEdgeRows: 20_000,
    maxSetRows: 10_000,
    timeBudgetMs: 6 * 60_000,
    windowDays: 30,
    minSetSupport: 5,
    minSetShare: 0.01,
    maxSetCandidates: 5_000,
    minIntentUnits: 5,
    intentGroupRelevance: 0.4,
    maxSessions: 100_000,
    maxCallsPerSession: 500,
  },
  sandboxes: { modalApp: "ratel-sandboxes", region: "eu", limits: SANDBOX_HARD_LIMITS },
  topics: {
    maxTurns: 20_000,
    newMinTurns: 5,
    maxJudgedAsks: 300,
    maxSentimentAsks: 300,
    maxJudgeTokens: 2_000_000,
  },
} as const;

/** The browser's config: the defaults only (see above). */
export function getConfig(): Config {
  return CONFIG_DEFAULTS as unknown as Config;
}
