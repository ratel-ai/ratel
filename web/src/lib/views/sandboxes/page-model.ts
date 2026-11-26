import type { SealedSecretsKey } from "@/lib/platform/sealed-secrets";
import type { ProviderKind } from "./adapters/provider-from-env";
import { type RatelYaml, secretNamesOf } from "./domain/config";
import type { SmokeResult, ToolMode } from "./domain/contract";
import type { SandboxRun } from "./domain/run";
import { runView } from "./domain/run";
import type { SandboxVersion, VersionStatus } from "./domain/version";
import type { RunStore } from "./ports/run-store";
import type { SecretStore } from "./ports/secret-store";
import type { VersionStore } from "./ports/version-store";
import type { ParamSpec } from "./run-form";

/** What the Ratel sandbox page shows. Plain data: no image reference, instance or secret value. */
export type SandboxPageModel = {
  projectId: string;
  /** Whether this deployment can build and run sandboxes. */
  configured: boolean;
  /** Each setting of the server that is missing or wrong. Empty when all is set. */
  problems: ConfigProblem[];
  canEdit: boolean;
  versions: VersionRow[];
  secrets: SecretRow[];
  runs: RunRow[];
};

export type VersionRow = {
  id: string;
  name: string;
  status: VersionStatus;
  reason: string | null;
  /** Null when the push had no git information. */
  commit: string | null;
  dirty: boolean;
  createdAt: string;
  buildLog: string | null;
  smoke: SmokeResult | null;
  spec: VersionSpec;
};

/** What `ratel.yaml` of a version declares: what a run takes and how it runs. */
export type VersionSpec = {
  inputExample: unknown;
  params: ParamSpec[];
  tools: Array<{ name: string; mode: ToolMode }>;
  runMode: "http" | "command";
  timeoutSeconds: number | null;
};

/** A setting of the server that is missing or wrong, by its name. */
export type ConfigProblem = { setting: string; message: string };

export type SecretRow = {
  name: string;
  /** Null when there is no value. */
  updatedAt: string | null;
  /** Whether the latest version names it. */
  declared: boolean;
};

export type RunRow = ReturnType<typeof runView>;

const VERSIONS = 20;
const RUNS = 10;

export async function loadSandboxPage(
  projectId: string,
  canEdit: boolean,
  deps: {
    versions: Pick<VersionStore, "list">;
    secrets: Pick<SecretStore, "list">;
    runs: Pick<RunStore, "list">;
    configured: () => boolean;
    problems: () => ConfigProblem[];
  },
): Promise<SandboxPageModel> {
  const [versions, secrets, runs] = await Promise.all([
    deps.versions.list(projectId, VERSIONS),
    deps.secrets.list(projectId),
    deps.runs.list(projectId, RUNS),
  ]);
  return {
    projectId,
    configured: deps.configured(),
    problems: deps.problems(),
    canEdit,
    versions: versions.map(versionRow),
    secrets: secretRows(versions, secrets),
    runs: runs.map((run: SandboxRun) => runView(run)),
  };
}

function versionRow(version: SandboxVersion): VersionRow {
  return {
    id: version.id,
    name: version.name,
    status: version.status,
    reason: version.reason,
    commit: version.git?.commit ?? null,
    dirty: version.git?.dirty ?? false,
    createdAt: version.createdAt.toISOString(),
    buildLog: version.buildLog,
    smoke: version.smoke,
    spec: versionSpec(version.config),
  };
}

/** The spec of a version. A tool with no mode is `simulated`, a run with no mode is `http`. */
export function versionSpec(config: RatelYaml): VersionSpec {
  return {
    inputExample: config.input.example ?? null,
    params: Object.entries(config.params ?? {}).map(([name, param]) => ({
      name,
      type: param.type,
      default: param.default ?? null,
      description: param.description ?? null,
      options: param.options ?? [],
    })),
    tools: Object.entries(config.tools ?? {}).map(([name, tool]) => ({
      name,
      mode: tool.mode ?? "simulated",
    })),
    runMode: config.run?.mode ?? "http",
    timeoutSeconds: config.run?.timeoutSeconds ?? null,
  };
}

/**
 * The settings that stop a push, a run or a secret, each with its name. It reads no secret value:
 * the provider and the sealing key come checked.
 */
export function configurationProblems(
  provider: ProviderKind,
  sealing: SealedSecretsKey,
): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  if (provider.kind === "refused") {
    problems.push({ setting: "SANDBOX_PROVIDER", message: provider.reason });
  } else if (provider.kind === "none") {
    problems.push({
      setting: "SANDBOX_PROVIDER",
      message:
        "No provider runs sandboxes on this server. A push and a run are refused until an operator sets one.",
    });
  }
  if (!sealing.ok) problems.push({ setting: "SANDBOX_SECRETS_KEY", message: sealing.message });
  return problems;
}

/** The names that the latest version of each sandbox declares, missing first, then the others. */
export function secretRows(
  versions: readonly SandboxVersion[],
  secrets: ReadonlyArray<{ name: string; updatedAt: Date }>,
): SecretRow[] {
  const latest = new Map<string, SandboxVersion>();
  for (const version of versions) {
    if (!latest.has(version.name)) latest.set(version.name, version);
  }
  const declared = new Set(
    [...latest.values()].flatMap((version) => secretNamesOf(version.config)),
  );
  const set = new Map(secrets.map((secret) => [secret.name, secret.updatedAt.toISOString()]));
  return [...new Set([...declared, ...set.keys()])]
    .map((name) => ({ name, updatedAt: set.get(name) ?? null, declared: declared.has(name) }))
    .sort(
      (a, b) =>
        Number(a.updatedAt !== null) - Number(b.updatedAt !== null) || (a.name < b.name ? -1 : 1),
    );
}
