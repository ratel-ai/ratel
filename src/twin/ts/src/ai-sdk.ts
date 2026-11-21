/**
 * `@ratel-ai/twin/ai-sdk`: the AI SDK path of a twin. A model param becomes an
 * AI SDK `LanguageModel`, through AI Gateway when `AI_GATEWAY_API_KEY` is set,
 * else through the project's own `@ai-sdk/<provider>` package and key. It
 * imports `ai` and the provider packages only when a run resolves a model, and
 * from the project of the twin file, never from where @ratel-ai/twin is
 * installed: the model must come from the same `ai` the agent's `streamText`
 * uses. The core entry never imports `ai`.
 */
import type { LanguageModel, ModelMessage } from "ai";
import { ModelResolutionError } from "./errors.js";
import { bareModelId } from "./params.js";
import { type ProjectPackages, projectPackages } from "./project-packages.js";
import type { CallableProvider } from "./providers.js";
import type { FakeAnswer, FakeRequest } from "./tools.js";
import {
  type ChatInput,
  type ChatRunInput,
  chat,
  type ModelResolver,
  type ResolveContext,
  type RunContext,
} from "./twin.js";

type Env = Readonly<Record<string, string | undefined>>;
type ModuleLoader = (specifier: string) => Promise<Record<string, unknown>>;

/** A model prefix the runner can call without the gateway: its package, factory and key. */
export interface AiSdkProvider {
  readonly package: string;
  readonly factory: string;
  readonly key: string;
}

export const GATEWAY_KEY = "AI_GATEWAY_API_KEY";

/**
 * The small model that generates a fake tool result in a local run, with the
 * user's own key. The gateway names models with dots, Anthropic with dashes.
 */
export const FAKE_MODEL = {
  gateway: "anthropic/claude-haiku-5.5",
  direct: "anthropic/claude-haiku-5-5",
} as const;

/** The built-in map of a model prefix to its `@ai-sdk/*` provider package. */
export const AI_SDK_PROVIDERS: Readonly<Record<string, AiSdkProvider>> = {
  anthropic: { package: "@ai-sdk/anthropic", factory: "createAnthropic", key: "ANTHROPIC_API_KEY" },
  google: {
    package: "@ai-sdk/google",
    factory: "createGoogleGenerativeAI",
    key: "GOOGLE_GENERATIVE_AI_API_KEY",
  },
  openai: { package: "@ai-sdk/openai", factory: "createOpenAI", key: "OPENAI_API_KEY" },
};

export interface AiSdkModelsOptions {
  /** Read at each resolve. Default: `process.env`. */
  readonly env?: Env;
  /** Imports a package. Default: from the project of the twin file. */
  readonly load?: ModuleLoader;
  /** True when the project has the package. Default: from the project of the twin file. */
  readonly installed?: (specifier: string) => boolean;
}

/** The packages one resolve sees: the twin file's project, or the test's stand-ins. */
interface Packages {
  readonly where: string;
  readonly load: ModuleLoader;
  readonly installed: (specifier: string) => boolean;
}

/**
 * The model resolver of an AI SDK twin: pass it as `resolve`. run() gets a
 * `LanguageModel` for each model param. A value with no way to run rejects
 * with a ModelResolutionError that says what to set or install.
 */
export function aiSdkModels(options: AiSdkModelsOptions = {}): ModelResolver<LanguageModel> {
  const envOf = () => options.env ?? process.env;
  const packagesOf = (context: ResolveContext = {}): Packages => {
    // The runner passes the twin file. Without it (a direct call), the current folder's project.
    const project: ProjectPackages = projectPackages(context.from ?? process.cwd());
    return {
      where: `the project at ${project.root}`,
      load: options.load ?? project.load,
      installed: options.installed ?? project.installed,
    };
  };
  const resolve = (modelId: string, context?: ResolveContext) =>
    resolveModel(modelId, envOf(), packagesOf(context));
  return Object.assign(resolve, {
    modelKind: "language-model" as const,
    callableProviders: (env: Env, context?: ResolveContext) =>
      aiSdkCallableProviders(env, packagesOf(context).installed),
    generateFake: (request: FakeRequest, signal: AbortSignal, context?: ResolveContext) =>
      generateFake(request, envOf(), packagesOf(context), signal),
  });
}

/**
 * The providers an AI SDK twin can call: the gateway when its key is set, and
 * each provider whose key is set and whose package is installed. Key names only.
 */
export function aiSdkCallableProviders(
  env: Env,
  installed: (specifier: string) => boolean = projectPackages(process.cwd()).installed,
): CallableProvider[] {
  const providers: CallableProvider[] = [];
  if (env[GATEWAY_KEY] && installed("ai"))
    providers.push({ provider: "gateway", keys: [GATEWAY_KEY] });
  for (const [provider, entry] of Object.entries(AI_SDK_PROVIDERS)) {
    if (env[entry.key] && installed(entry.package)) providers.push({ provider, keys: [entry.key] });
  }
  return providers.sort((a, b) => a.provider.localeCompare(b.provider));
}

/** The chat input of an AI SDK twin: run() gets `{ messages: ModelMessage[] }`. */
export function aiSdkChat(): ChatInput<ChatRunInput<ModelMessage>> {
  return chat<ModelMessage>();
}

/**
 * Streams each piece of `textStream` (e.g. `streamText(...).textStream`) to the
 * playground as a `text.delta` event and resolves with the whole text.
 */
export async function forwardText(
  textStream: AsyncIterable<string>,
  ctx: Pick<RunContext, "textDelta">,
): Promise<string> {
  let text = "";
  for await (const piece of textStream) {
    text += piece;
    ctx.textDelta(piece);
  }
  return text;
}

/**
 * Asks a small model for a plausible result of one tool call: the tool's
 * description and schemas, the arguments and the last messages. Local runs
 * only; in the playground Ratel generates fakes.
 */
async function generateFake(
  request: FakeRequest,
  env: Env,
  packages: Packages,
  signal: AbortSignal,
): Promise<FakeAnswer> {
  const modelId = env[GATEWAY_KEY] ? FAKE_MODEL.gateway : FAKE_MODEL.direct;
  const model = await resolveModel(modelId, env, packages);
  const ai = await loadOrExplain(
    packages,
    "ai",
    modelId,
    `the ai package is not installed in ${packages.where}`,
  );
  const generateText = ai.generateText as (options: Record<string, unknown>) => Promise<{
    text: string;
  }>;
  const { text } = await generateText({
    model,
    abortSignal: signal,
    system:
      "You stand in for a tool in a test run of an AI agent. Reply with only the JSON value the tool would return for this call: no prose, no code fence. Keep it short and consistent with the arguments.",
    prompt: JSON.stringify({
      tool: request.tool,
      description: request.description,
      inputSchema: request.inputSchema,
      outputSchema: request.outputSchema,
      args: request.args,
      recentMessages: request.messages,
    }),
  });
  return { result: parseJsonLoose(text), isError: false, source: "generated" };
}

function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

async function resolveModel(modelId: string, env: Env, packages: Packages): Promise<LanguageModel> {
  const gatewayKey = env[GATEWAY_KEY];
  if (gatewayKey) {
    const ai = await loadOrExplain(
      packages,
      "ai",
      modelId,
      `the ai package is not installed in ${packages.where}. Install it there`,
    );
    const createGateway = factoryOf(ai, "createGateway", "ai", modelId);
    return createGateway({ apiKey: gatewayKey })(modelId) as LanguageModel;
  }
  const prefix = modelId.slice(0, Math.max(0, modelId.indexOf("/")));
  const entry = AI_SDK_PROVIDERS[prefix];
  if (!entry) {
    throw new ModelResolutionError(
      modelId,
      `cannot run ${modelId}: there is no built-in AI SDK provider for "${prefix}". Set ${GATEWAY_KEY} to call it through AI Gateway, or pass your own resolve`,
    );
  }
  const key = env[entry.key];
  if (!key) {
    throw new ModelResolutionError(
      modelId,
      `cannot run ${modelId}: set ${GATEWAY_KEY}, or set ${entry.key} and install ${entry.package}`,
    );
  }
  const mod = await loadOrExplain(
    packages,
    entry.package,
    modelId,
    `${entry.package} is not installed in ${packages.where}. Install it there, or set ${GATEWAY_KEY}`,
  );
  const create = factoryOf(mod, entry.factory, entry.package, modelId);
  return create({ apiKey: key })(bareModelId(modelId)) as LanguageModel;
}

async function loadOrExplain(
  packages: Packages,
  specifier: string,
  modelId: string,
  why: string,
): Promise<Record<string, unknown>> {
  try {
    return await packages.load(specifier);
  } catch {
    throw new ModelResolutionError(modelId, `cannot run ${modelId}: ${why}`);
  }
}

type ProviderFactory = (settings: { apiKey: string }) => (modelId: string) => unknown;

function factoryOf(
  mod: Record<string, unknown>,
  name: string,
  specifier: string,
  modelId: string,
): ProviderFactory {
  const factory = mod[name];
  if (typeof factory !== "function") {
    throw new ModelResolutionError(
      modelId,
      `cannot run ${modelId}: ${specifier} has no ${name} export. Check its version`,
    );
  }
  return factory as ProviderFactory;
}
