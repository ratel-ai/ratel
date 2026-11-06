/**
 * OTel `gen_ai.*` (pinned semconv v1.42.0) and Ratel `ratel.*` overlay keys the
 * mapper reads. Mirrors the vocabulary in `@ratel-ai/telemetry` — kept as a local
 * copy because the Cloud app is a pure OTLP *consumer* and doesn't depend on the
 * emitter packages. See ratel-ai/ratel `src/telemetry/CONVENTIONS.md` for the
 * authoritative contract.
 */

/** Span event carrying message/tool content (opt-in; absent by default). */
export const GEN_AI_INFERENCE_DETAILS = "gen_ai.client.inference.operation.details";

/** `gen_ai.operation.name` value marking a tool-invocation span (never an anchor). */
export const EXECUTE_TOOL = "execute_tool";

/** `gen_ai.operation.name` values that mark an LLM-call span (the anchor of a call). */
export const LLM_OPERATIONS: ReadonlySet<string> = new Set([
  "chat",
  "generate_content",
  "text_completion",
  "generate",
  "complete",
  "embeddings",
]);

/**
 * Operations that are never one model round trip. The agent-level ones
 * (`invoke_agent` and friends) often carry the run's summed usage and its
 * model (AI SDK 7, Mastra), which the usage fallback in `isAnchor` would
 * otherwise read as one more call, counting every token twice.
 */
export const NON_ROUND_TRIP_OPERATIONS: ReadonlySet<string> = new Set([
  "embeddings",
  "invoke_agent",
  "create_agent",
  "agent_step",
  "invoke_workflow",
  "retrieval",
]);

/** Any attribute with this prefix marks token usage (anchor-detection fallback). */
export const USAGE_PREFIX = "gen_ai.usage.";

/** `gen_ai.*` attribute keys. */
export const GEN_AI = {
  operationName: "gen_ai.operation.name",
  providerName: "gen_ai.provider.name",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  responseId: "gen_ai.response.id",
  conversationId: "gen_ai.conversation.id",
  finishReasons: "gen_ai.response.finish_reasons",
  usageInputTokens: "gen_ai.usage.input_tokens",
  usageOutputTokens: "gen_ai.usage.output_tokens",
  usageCacheRead: "gen_ai.usage.cache_read.input_tokens",
  usageCacheCreation: "gen_ai.usage.cache_creation.input_tokens",
  usageReasoning: "gen_ai.usage.reasoning.output_tokens",
  requestStream: "gen_ai.request.stream",
  requestTemperature: "gen_ai.request.temperature",
  requestTopP: "gen_ai.request.top_p",
  requestMaxTokens: "gen_ai.request.max_tokens",
  requestStopSequences: "gen_ai.request.stop_sequences",
  systemInstructions: "gen_ai.system_instructions",
  inputMessages: "gen_ai.input.messages",
  outputMessages: "gen_ai.output.messages",
  toolName: "gen_ai.tool.name",
  toolDefinitions: "gen_ai.tool.definitions",
  toolCallId: "gen_ai.tool.call.id",
  toolCallArguments: "gen_ai.tool.call.arguments",
  toolCallResult: "gen_ai.tool.call.result",
  retrievalQueryText: "gen_ai.retrieval.query.text",
  retrievalDocuments: "gen_ai.retrieval.documents",
  legacyPrompt: "gen_ai.prompt",
  legacyCompletion: "gen_ai.completion",
} as const;

/** `ratel.search` — the SDK funnel's capability-search span (tool or skill). */
export const RATEL_SEARCH = "ratel.search";

/** `ratel.*` attribute keys (Tier 2 overlay). Content-bearing keys ride the span
 * only when the emitter's capture gate selects a span mode (default off). */
export const RATEL = {
  eventId: "ratel.event.id",
  origin: "ratel.origin",
  searchTarget: "ratel.search.target",
  searchTopK: "ratel.search.top_k",
  searchHitCount: "ratel.search.hit_count",
  searchQuery: "ratel.search.query",
} as const;

/** `ratel.catalog.definition` log-record vocabulary. */
export const RATEL_CATALOG = {
  definition: "ratel.catalog.definition",
  kind: "ratel.catalog.kind",
  id: "ratel.catalog.id",
  name: "ratel.catalog.name",
  description: "ratel.catalog.description",
  tags: "ratel.catalog.tags",
  inputSchema: "ratel.catalog.input_schema",
  outputSchema: "ratel.catalog.output_schema",
  schemaOmitted: "ratel.catalog.schema_omitted",
  searchableDescription: "ratel.catalog.searchable_description",
  searchableDescriptionOverridden: "ratel.catalog.searchable_description_overridden",
  useCloudDefinitions: "ratel.catalog.use_definition_overrides",
  contentHash: "ratel.catalog.content_hash",
} as const;

/** `ratel.experiment.*` baggage copied onto every span in an experiment run.
 * `id` is the experiment identifier (a human slug like "retrieval-v2"); it feeds
 * the `experimentName` column. There is no `ratel.experiment.name` in the SDK
 * vocabulary — see ratel-ai/ratel `src/telemetry/CONVENTIONS.md`. */
export const RATEL_EXPERIMENT = {
  prefix: "ratel.experiment.",
  id: "ratel.experiment.id",
  selectionId: "ratel.experiment.selection_id",
  arm: "ratel.experiment.arm",
  role: "ratel.experiment.role",
} as const;
