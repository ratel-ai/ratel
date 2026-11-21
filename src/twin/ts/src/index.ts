/**
 * `@ratel-ai/twin`: declare the params of an agent next to its code, so Ratel
 * can run the real code with a changed model, prompt or scalar. This entry is
 * the production import path: it opens no socket and does no network I/O.
 */
import { bool, enumParam, int, model, number, prompt, string } from "./params.js";
import { tools } from "./tools.js";
import { chat, context, defineTwin, structured } from "./twin.js";

export {
  ModelResolutionError,
  type ParamIssue,
  TwinInputError,
  TwinParamError,
} from "./errors.js";
export { canonicalJson, configHash } from "./hash.js";
export {
  buildManifest,
  type Manifest,
  type ManifestTwin,
  manifestTwin,
  SDK_NAME,
  SDK_VERSION,
} from "./manifest.js";
export {
  RATEL_REPLAY_ARM,
  RATEL_REPLAY_SOURCE_SESSION_ID,
  RATEL_REPLAY_SOURCE_TRACE_ID,
  RATEL_TWIN_CONFIG_HASH,
  RATEL_TWIN_ID,
  RATEL_TWIN_INPUT,
  RATEL_TWIN_OVERRIDES,
  RATEL_TWIN_RUN_ID,
  resolveLocal,
  stampTwinInput,
  TWIN_INPUT_MAX_CHARS,
} from "./otel.js";
export {
  bareModelId,
  coerceOverride,
  type Param,
  type ParamMap,
  type ParamValues,
} from "./params.js";
export { type CallableProvider, callableProviders, PROVIDER_KEYS } from "./providers.js";
export { type ResolvedParams, resolveParams, settleParams } from "./resolve.js";
export { type RunTwinOptions, type RunTwinResult, runTwin } from "./run.js";
export {
  CONFIRM_TIMEOUT_MS,
  type ConfirmAnswer,
  type ConfirmDecision,
  type ConfirmRequest,
  defaultMode,
  type FakeAnswer,
  type FakeRequest,
  type FakeSource,
  prepareTools,
  RATEL_TOOL_CONFIRM_DECISION,
  RATEL_TOOL_FAKE_SOURCE,
  RATEL_TOOL_MODE,
  REJECTED_RESULT,
  resolveToolModes,
  type ToolChannel,
  type ToolDescriptor,
  type ToolEdit,
  type ToolHint,
  type ToolHints,
  type ToolMode,
  ToolModeError,
  type ToolsParam,
} from "./tools.js";
export {
  type ChatInput,
  type ChatMessage,
  type ChatRunInput,
  checkInput,
  isTwin,
  type LogLevel,
  type ModelResolver,
  type RunContext,
  type StructuredInput,
  type Twin,
  type TwinDefinition,
  type TwinEventPayload,
  type TwinInput,
} from "./twin.js";

/** `twin(id, { params, input, context, run })` plus the param (incl. `tools`), input and context builders. */
export const twin = Object.assign(defineTwin, {
  model,
  prompt,
  int,
  number,
  bool,
  enum: enumParam,
  string,
  structured,
  chat,
  context,
  tools,
});
