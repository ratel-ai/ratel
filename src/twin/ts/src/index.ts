/**
 * `@ratel-ai/twin`: declare the params of an agent next to its code, so Ratel
 * can run the real code with a changed model, prompt or scalar. This entry is
 * the production import path: it opens no socket and does no network I/O.
 */
import { bool, enumParam, int, model, number, prompt, string } from "./params.js";
import { defineTwin, structured } from "./twin.js";

export { type ParamIssue, TwinParamError } from "./errors.js";
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
  RATEL_TWIN_CONFIG_HASH,
  RATEL_TWIN_ID,
  RATEL_TWIN_INPUT,
  resolveLocal,
  stampTwinInput,
  TWIN_INPUT_MAX_CHARS,
} from "./otel.js";
export { bareModelId, type Param, type ParamMap, type ParamValues } from "./params.js";
export { type CallableProvider, callableProviders, PROVIDER_KEYS } from "./providers.js";
export { type ResolvedParams, resolveParams } from "./resolve.js";
export { type RunTwinOptions, type RunTwinResult, runTwin } from "./run.js";
export {
  isTwin,
  type RunContext,
  type StructuredInput,
  type Twin,
  type TwinDefinition,
} from "./twin.js";

/** `twin(id, { params, input, run })` plus the param and input builders. */
export const twin = Object.assign(defineTwin, {
  model,
  prompt,
  int,
  number,
  bool,
  enum: enumParam,
  string,
  structured,
});
