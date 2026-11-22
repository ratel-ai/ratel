import { join } from "node:path";
import type { ImageSpec, SandboxState } from "./image.js";
import type { Param } from "./params.js";
import { type CallableProvider, callableProviders } from "./providers.js";
import type { Sandbox } from "./sandbox.js";

/** Kept equal to package.json by a test. */
export const SDK_VERSION = "0.1.0";
export const SDK_NAME = "@ratel-ai/sandbox";

/** The manifest of protocol/sandbox/v1 (schema/manifest.schema.json). */
export interface Manifest {
  readonly sdk: {
    readonly language: "typescript";
    readonly name: string;
    readonly version: string;
  };
  readonly build?: {
    readonly id?: string;
    readonly dirty?: boolean;
    /** SHA-256 of the sandbox files' content. Changes with every edit of a sandbox file. */
    readonly revision?: string;
  };
  readonly providers: readonly CallableProvider[];
  readonly sandboxes: readonly ManifestSandbox[];
}

export interface ManifestSandbox {
  readonly id: string;
  readonly file?: string;
  readonly modelResolver: "builtin" | "custom";
  /** Set when run() gets an AI SDK `LanguageModel` for a model param. Absent: the bare ID. */
  readonly modelKind?: "language-model";
  readonly input:
    | { readonly kind: "structured"; readonly schema: Readonly<Record<string, unknown>> }
    | { readonly kind: "chat" };
  readonly output?:
    | { readonly kind: "structured"; readonly schema: Readonly<Record<string, unknown>> }
    | { readonly kind: "text" };
  /** run: one instance per run. session: one instance per session. */
  readonly state: SandboxState;
  /** The image of a hosted instance. Env holds names only. */
  readonly image?: ImageSpec;
  readonly params: readonly ManifestParam[];
  readonly context: readonly { readonly name: string; readonly default?: unknown }[];
}

export type ManifestParam = { readonly name: string } & Param;

export interface BuildManifestOptions {
  readonly sandboxes: readonly { readonly sandbox: Sandbox; readonly file?: string }[];
  readonly build?: Manifest["build"];
  /** Read for key names only. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The project root the sandbox files are relative to: a resolver checks packages from there. */
  readonly root?: string;
}

/** Plain data describing what a worker can run. No code and no key values. */
export function buildManifest(options: BuildManifestOptions): Manifest {
  const env = options.env ?? {};
  return {
    sdk: { language: "typescript", name: SDK_NAME, version: SDK_VERSION },
    ...(options.build ? { build: options.build } : {}),
    providers: manifestProviders(options.sandboxes, env, options.root),
    sandboxes: options.sandboxes.map(({ sandbox, file }) => manifestSandbox(sandbox, file)),
  };
}

export function manifestSandbox(sandbox: Sandbox, file?: string): ManifestSandbox {
  return {
    id: sandbox.id,
    ...(file ? { file } : {}),
    modelResolver: sandbox.resolve && !sandbox.resolve.callableProviders ? "custom" : "builtin",
    ...(sandbox.resolve?.modelKind ? { modelKind: sandbox.resolve.modelKind } : {}),
    input:
      sandbox.input.kind === "chat"
        ? { kind: "chat" }
        : { kind: "structured", schema: sandbox.input.schema },
    ...(sandbox.output
      ? {
          output:
            sandbox.output.kind === "text"
              ? { kind: "text" }
              : { kind: "structured", schema: sandbox.output.schema },
        }
      : {}),
    state: sandbox.state ?? "run",
    ...(sandbox.image ? { image: manifestImage(sandbox.image) } : {}),
    params: Object.entries(sandbox.params).map(([name, param]) => ({ name, ...param })),
    context: Object.entries(sandbox.context ?? {}).map(([name, value]) => ({
      name,
      default: value,
    })),
  };
}

/** Plain data: a copy with no frozen arrays and no absent optional fields. */
function manifestImage(image: ImageSpec): ImageSpec {
  return {
    base: image.base,
    install: [...image.install],
    copy: [...image.copy],
    sidecars: image.sidecars.map((sidecar) => ({ ...sidecar })),
    env: [...image.env],
  };
}

/**
 * The providers the worker can call. A built-in resolver (the AI SDK one) lists
 * only what it can reach: the gateway key, or a provider key with its package
 * installed. Other sandboxes call their own client, so for them a set key is
 * enough. The list is the union over the sandboxes, sorted by name.
 */
function manifestProviders(
  sandboxes: BuildManifestOptions["sandboxes"],
  env: Readonly<Record<string, string | undefined>>,
  root: string | undefined,
): CallableProvider[] {
  const byName = new Map<string, CallableProvider>();
  const lists = sandboxes.map(({ sandbox, file }) => {
    const from = root && file ? join(root, file) : undefined;
    return (
      sandbox.resolve?.callableProviders?.(env, from ? { from } : {}) ?? callableProviders(env)
    );
  });
  for (const provider of (sandboxes.length > 0 ? lists : [callableProviders(env)]).flat()) {
    byName.set(provider.provider, provider);
  }
  return [...byName.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}
