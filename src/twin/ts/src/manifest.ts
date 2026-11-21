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
  readonly build?: { readonly id?: string; readonly dirty?: boolean };
  readonly providers: readonly CallableProvider[];
  readonly twins: readonly ManifestTwin[];
}

export interface ManifestTwin {
  readonly id: string;
  readonly file?: string;
  readonly modelResolver: "builtin" | "custom";
  readonly input: {
    readonly kind: "structured";
    readonly schema: Readonly<Record<string, unknown>>;
  };
  readonly params: readonly ManifestParam[];
  readonly context: readonly { readonly name: string; readonly default?: unknown }[];
}

export type ManifestParam = { readonly name: string } & Omit<Param, "__value">;

export interface BuildManifestOptions {
  readonly twins: readonly { readonly twin: Twin; readonly file?: string }[];
  readonly build?: Manifest["build"];
  /** Read for key names only. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Plain data describing what a worker can run. No code and no key values. */
export function buildManifest(options: BuildManifestOptions): Manifest {
  return {
    sdk: { language: "typescript", name: SDK_NAME, version: SDK_VERSION },
    ...(options.build ? { build: options.build } : {}),
    providers: callableProviders(options.env ?? {}),
    twins: options.twins.map(({ twin, file }) => manifestTwin(twin, file)),
  };
}

export function manifestTwin(twin: Twin, file?: string): ManifestTwin {
  return {
    id: twin.id,
    ...(file ? { file } : {}),
    modelResolver: twin.resolve ? "custom" : "builtin",
    input: { kind: twin.input.kind, schema: twin.input.schema },
    params: Object.entries(twin.params).map(([name, param]) => ({ name, ...param })),
    context: Object.entries(twin.context ?? {}).map(([name, value]) => ({ name, default: value })),
  };
}
