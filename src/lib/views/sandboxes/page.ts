import type { RecordedItem, RecordedItemsQuery } from "./adapters/recorded-items";
import type { PlaygroundParam } from "./playground-state";
import type { SandboxRunnerView } from "./ports/store";
import { defaultConfigHash, findManifestSandbox, type ManifestSandboxView } from "./run-request";

/**
 * The loaders of the Sandboxes pages (RC-1102): the caller's own `ratel sandbox dev`
 * runner, the sandboxes of its manifest, and for one sandbox what the playground
 * needs to draw its form, its params and its config pill. A run goes only to
 * its owner's runner (spec §2 rule 4), so another user's runner never shows.
 */

export interface SandboxesPageDeps {
  listRunners: (projectId: string) => Promise<SandboxRunnerView[]>;
  productionConfigHash: (query: {
    projectId: string;
    sandboxId: string;
    now: Date;
  }) => Promise<string | null>;
  recordedItems: (query: RecordedItemsQuery) => Promise<RecordedItem[]>;
  now: () => Date;
}

export interface RunnerSummary {
  id: string;
  online: boolean;
  /** How many runs the runner takes at once (its `registered` limit). */
  maxConcurrency: number;
  /** The git SHA, short, and whether the tree had changes. Null when the runner sent no build. */
  build: { sha: string | null; dirty: boolean } | null;
  connectedAt: string;
  lastSeenAt: string;
}

export interface SandboxSummary {
  id: string;
  file: string | null;
  inputKind: "structured" | "chat";
  paramCount: number;
}

export interface CallableProviderView {
  provider: string;
  keys: string[];
}

/** One sandbox as the playground draws it: the manifest sandbox, with its params typed. */
export interface PlaygroundSandbox {
  id: string;
  file: string | null;
  modelResolver: "builtin" | "custom";
  input: ManifestSandboxView["input"];
  params: PlaygroundParam[];
  context: { name: string; default?: unknown }[];
}

/** A recorded production item as the browser gets it (RC-1103). */
export interface RecordedItemView {
  spanId: string;
  traceId: string;
  startedAt: string;
  input: unknown;
  recordedOutput: unknown;
}

export interface SandboxesPageModel {
  runner: RunnerSummary | null;
  sandboxes: SandboxSummary[];
}

export interface SandboxPageModel {
  runner: RunnerSummary | null;
  sandbox: PlaygroundSandbox | null;
  providers: CallableProviderView[];
  /** The hash a run with no edits gets. */
  defaultConfigHash: string | null;
  /** The hash production ran this sandbox with in the last 30 days, or null. */
  productionHash: string | null;
  /** The recorded item `?span=` names ("Open in sandbox"), or null. */
  item: RecordedItemView | null;
}

const SHORT_SHA = 7;

/** The Sandboxes list: the sandboxes of the caller's own runner, online first. */
export async function loadSandboxesPage(
  scope: { projectId: string; externalId: string },
  deps: SandboxesPageDeps,
): Promise<SandboxesPageModel> {
  const own = ownRunner(await deps.listRunners(scope.projectId), scope.externalId);
  if (!own) return { runner: null, sandboxes: [] };
  return {
    runner: runnerSummary(own),
    sandboxes: manifestSandboxes(own.manifest).map(sandboxSummary),
  };
}

/** One sandbox's playground: the sandbox on the caller's runner, its providers and the two hashes the pill compares. */
export async function loadSandboxPage(
  scope: { projectId: string; externalId: string; sandboxId: string; spanId?: string | null },
  deps: SandboxesPageDeps,
): Promise<SandboxPageModel> {
  const own = ownRunner(await deps.listRunners(scope.projectId), scope.externalId);
  const sandbox = own ? findManifestSandbox(own.manifest, scope.sandboxId) : null;
  const [productionHash, items] = sandbox
    ? await Promise.all([
        deps.productionConfigHash({
          projectId: scope.projectId,
          sandboxId: sandbox.id,
          now: deps.now(),
        }),
        scope.spanId
          ? deps.recordedItems({
              projectId: scope.projectId,
              sandboxId: sandbox.id,
              now: deps.now(),
              spanIds: [scope.spanId],
            })
          : [],
      ])
    : [null, []];
  return {
    item: items[0] ? recordedItemView(items[0]) : null,
    runner: own ? runnerSummary(own) : null,
    sandbox: sandbox ? playgroundSandbox(sandbox) : null,
    providers: own ? providersOf(own.manifest) : [],
    defaultConfigHash: sandbox ? defaultConfigHash(sandbox) : null,
    productionHash,
  };
}

/** A recorded item as JSON for the browser. */
export function recordedItemView(item: RecordedItem): RecordedItemView {
  return {
    spanId: item.spanId,
    traceId: item.traceId,
    startedAt: item.startedAt.toISOString(),
    input: item.input,
    recordedOutput: item.recordedOutput,
  };
}

/** The caller's runner: the newest online one, else the newest one at all (paused). */
export function ownRunner(
  runners: readonly SandboxRunnerView[],
  externalId: string,
): SandboxRunnerView | null {
  const mine = runners.filter((r) => r.ownerUserId === externalId);
  return mine.find((r) => r.online) ?? mine[0] ?? null;
}

function runnerSummary(runner: SandboxRunnerView): RunnerSummary {
  const build = runner.manifest.build as { id?: unknown; dirty?: unknown } | undefined;
  return {
    id: runner.id,
    online: runner.online,
    maxConcurrency: Math.max(1, runner.maxConcurrency || 1),
    build: build
      ? {
          sha: typeof build.id === "string" ? build.id.slice(0, SHORT_SHA) : null,
          dirty: build.dirty === true,
        }
      : null,
    connectedAt: runner.connectedAt.toISOString(),
    lastSeenAt: runner.lastSeenAt.toISOString(),
  };
}

export function manifestSandboxes(manifest: Record<string, unknown>): ManifestSandboxView[] {
  return Array.isArray(manifest.sandboxes)
    ? (manifest.sandboxes as ManifestSandboxView[]).filter((t) => typeof t?.id === "string")
    : [];
}

function sandboxSummary(sandbox: ManifestSandboxView & { file?: unknown }): SandboxSummary {
  return {
    id: sandbox.id,
    file: typeof sandbox.file === "string" ? sandbox.file : null,
    inputKind: sandbox.input?.kind === "chat" ? "chat" : "structured",
    paramCount: Array.isArray(sandbox.params) ? sandbox.params.length : 0,
  };
}

function playgroundSandbox(
  sandbox: ManifestSandboxView & { file?: unknown; modelResolver?: unknown; context?: unknown },
): PlaygroundSandbox {
  return {
    id: sandbox.id,
    file: typeof sandbox.file === "string" ? sandbox.file : null,
    modelResolver: sandbox.modelResolver === "custom" ? "custom" : "builtin",
    input: sandbox.input,
    params: (sandbox.params ?? []) as unknown as PlaygroundParam[],
    context: Array.isArray(sandbox.context)
      ? (sandbox.context as PlaygroundSandbox["context"])
      : [],
  };
}

function providersOf(manifest: Record<string, unknown>): CallableProviderView[] {
  if (!Array.isArray(manifest.providers)) return [];
  return (manifest.providers as { provider?: unknown; keys?: unknown }[])
    .filter((p) => typeof p?.provider === "string")
    .map((p) => ({
      provider: p.provider as string,
      keys: Array.isArray(p.keys) ? p.keys.filter((k): k is string => typeof k === "string") : [],
    }));
}
