import type { Param } from "./params.js";
import { type CallableProvider, callableProviders } from "./providers.js";
import type { Twin } from "./twin.js";

/** Kept equal to package.json by a test. */
export const SDK_VERSION = "0.1.0";
export const SDK_NAME = "@ratel-ai/twin";

/** The manifest of protocol/twin/v1 (schema/manifest.schema.json). */
export interface Manifest {
  readonly sdk: {
    readonly language: "typescript";
    readonly name: string;
    readonly version: string;
  };
  readonly build?: {
    readonly id?: string;
    readonly dirty?: boolean;
    /** SHA-256 of the twin files' content. Changes with every edit of a twin file. */
    readonly revision?: string;
  };
  readonly providers: readonly CallableProvider[];
  readonly twins: readonly ManifestTwin[];
}

export interface ManifestTwin {
  readonly id: string;
  readonly file?: string;
  readonly modelResolver: "builtin" | "custom";
  /** Set when run() gets an AI SDK `LanguageModel` for a model param. Absent: the bare ID. */
  readonly modelKind?: "language-model";
  readonly input:
    | { readonly kind: "structured"; readonly schema: Readonly<Record<string, unknown>> }
    | { readonly kind: "chat" };
  readonly params: readonly ManifestParam[];
  readonly context: readonly { readonly name: string; readonly default?: unknown }[];
}

export type ManifestParam = { readonly name: string } & Param;

export interface BuildManifestOptions {
  readonly twins: readonly { readonly twin: Twin; readonly file?: string }[];
  readonly build?: Manifest["build"];
  /** Read for key names only. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Plain data describing what a worker can run. No code and no key values. */
export function buildManifest(options: BuildManifestOptions): Manifest {
  const env = options.env ?? {};
  return {
    sdk: { language: "typescript", name: SDK_NAME, version: SDK_VERSION },
    ...(options.build ? { build: options.build } : {}),
    providers: manifestProviders(
      options.twins.map(({ twin }) => twin),
      env,
    ),
    twins: options.twins.map(({ twin, file }) => manifestTwin(twin, file)),
  };
}

export function manifestTwin(twin: Twin, file?: string): ManifestTwin {
  return {
    id: twin.id,
    ...(file ? { file } : {}),
    modelResolver: twin.resolve && !twin.resolve.callableProviders ? "custom" : "builtin",
    ...(twin.resolve?.modelKind ? { modelKind: twin.resolve.modelKind } : {}),
    input:
      twin.input.kind === "chat"
        ? { kind: "chat" }
        : { kind: "structured", schema: twin.input.schema },
    params: Object.entries(twin.params).map(([name, param]) => ({ name, ...param })),
    context: Object.entries(twin.context ?? {}).map(([name, value]) => ({ name, default: value })),
  };
}

/**
 * The providers the worker can call. A built-in resolver (the AI SDK one) lists
 * only what it can reach: the gateway key, or a provider key with its package
 * installed. Other twins call their own client, so for them a set key is
 * enough. The list is the union over the twins, sorted by name.
 */
function manifestProviders(
  twins: readonly Twin[],
  env: Readonly<Record<string, string | undefined>>,
): CallableProvider[] {
  const byName = new Map<string, CallableProvider>();
  const lists = twins.map((t) => t.resolve?.callableProviders?.(env) ?? callableProviders(env));
  for (const provider of (twins.length > 0 ? lists : [callableProviders(env)]).flat()) {
    byName.set(provider.provider, provider);
  }
  return [...byName.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}
