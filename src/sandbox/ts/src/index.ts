/**
 * `@ratel-ai/sandbox`: declare the params of an agent next to its code, so Ratel
 * can run the real code with a changed model, prompt or scalar. This entry is
 * the production import path: it opens no socket and does no network I/O.
 */
import { bool, enumParam, int, model, number, prompt, string } from "./params.js";
import { chat, context, defineSandbox, structured } from "./sandbox.js";
import { tools } from "./tools.js";

export {
  ModelResolutionError,
  type ParamIssue,
  SandboxInputError,
  SandboxParamError,
} from "./errors.js";
export { canonicalJson, configHash } from "./hash.js";
export {
  buildManifest,
  type Manifest,
  type ManifestSandbox,
  manifestSandbox,
  SDK_NAME,
  SDK_VERSION,
} from "./manifest.js";
export {
  RATEL_REPLAY_ARM,
  RATEL_REPLAY_SOURCE_SESSION_ID,
  RATEL_REPLAY_SOURCE_TRACE_ID,
  RATEL_SANDBOX_CONFIG_HASH,
  RATEL_SANDBOX_ID,
  RATEL_SANDBOX_INPUT,
  RATEL_SANDBOX_OVERRIDES,
  RATEL_SANDBOX_RUN_ID,
  resolveLocal,
  SANDBOX_INPUT_MAX_CHARS,
  stampSandboxInput,
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
export { type RunSandboxOptions, type RunSandboxResult, runSandbox } from "./run.js";
export {
  type ChatInput,
  type ChatMessage,
  type ChatRunInput,
  checkInput,
  isSandbox,
  type LogLevel,
  type ModelResolver,
  type RunContext,
  type Sandbox,
  type SandboxDefinition,
  type SandboxInput,
  type StructuredInput,
  type TwinEventPayload,
} from "./sandbox.js";
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

/** `sandbox(id, { params, input, context, run })` plus the param (incl. `tools`), input and context builders. */
export const sandbox = Object.assign(defineSandbox, {
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
