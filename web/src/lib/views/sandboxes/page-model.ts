import type { SealedSecretsKey } from "@/lib/platform/sealed-secrets";
import type { ProviderKind } from "./adapters/provider-from-env";
import { type RatelYaml, secretNamesOf } from "./domain/config";
import type { SmokeResult, ToolMode } from "./domain/contract";
import type { SandboxRun } from "./domain/run";
import { runView } from "./domain/run";
import type { SandboxVersion, VersionStatus } from "./domain/version";
import { sandboxHref } from "./paths";
import type { RunStore } from "./ports/run-store";
import type { SandboxIndex } from "./ports/sandbox-index";
import type { SecretStore } from "./ports/secret-store";
import type { VersionStore } from "./ports/version-store";
import type { ParamSpec } from "./run-form";
import { type SecretSource, secretSources } from "./secret-values";

/**
 * What the Sandboxes pages show: the list of the sandboxes of a project, and one sandbox. Plain
 * data: no image reference, instance or secret value.
 */
type ServerState = {
  projectId: string;
  /** Whether this deployment can build and run sandboxes. */
  configured: boolean;
  /** Each setting of the server that is missing or wrong. Empty when all is set. */
  problems: ConfigProblem[];
  canEdit: boolean;
};

export type SandboxListModel = ServerState & {
  sandboxes: SandboxListRow[];
  /** The project level of the secrets: each value, and each name a sandbox declares. */
  projectSecrets: ProjectSecretRow[];
};

export type SandboxListRow = {
  name: string;
  href: string;
  newest: {
    id: string;
    status: VersionStatus;
    reason: string | null;
    commit: string | null;
  };
  versions: number;
  /** The time of the newest push. */
  lastPushAt: string;
  lastRunAt: string | null;
};

export type ProjectSecretRow = {
  name: string;
  /** The time of the project value. Null when the project has no value. */
  updatedAt: string | null;
  /** The sandboxes whose newest version declares the name. */
  declaredBy: string[];
};

export type SandboxDetailModel = ServerState & {
  name: string;
  /** The newest first. */
  versions: VersionRow[];
  /** The runs that a person or a key started, the newest first. */
  runs: RunRow[];
  /** Each name that the newest version declares, with the level that gives its value. */
  secrets: SandboxSecretRow[];
  /** Sandbox values of names that the newest version does not declare. */
  undeclared: Array<{ name: string; updatedAt: string }>;
};

export type SandboxSecretRow = { name: string; source: SecretSource; updatedAt: string | null };

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
  /** The domains that the agent may reach. Empty: no outbound network. */
  network: string[];
  secrets: string[];
};

/** A setting of the server that is missing or wrong, by its name. */
export type ConfigProblem = { setting: string; message: string };

export type RunRow = ReturnType<typeof runView>;

type ServerDeps = { configured: () => boolean; problems: () => ConfigProblem[] };

const VERSIONS = 20;
const RUNS = 10;

/** The Sandboxes page: one row a sandbox, the newest push first, and the project secrets. */
export async function loadSandboxList(
  projectId: string,
  canEdit: boolean,
  deps: ServerDeps & { index: SandboxIndex; secrets: Pick<SecretStore, "list"> },
): Promise<SandboxListModel> {
  const [sandboxes, secrets] = await Promise.all([
    deps.index.list(projectId),
    deps.secrets.list(projectId, null),
  ]);
  return {
    ...serverState(projectId, canEdit, deps),
    sandboxes: sandboxes.map((sandbox) => ({
      name: sandbox.name,
      href: sandboxHref(projectId, sandbox.name),
      newest: {
        id: sandbox.newest.id,
        status: sandbox.newest.status,
        reason: sandbox.newest.reason,
        commit: sandbox.newest.git?.commit ?? null,
      },
      versions: sandbox.versions,
      lastPushAt: sandbox.newest.createdAt.toISOString(),
      lastRunAt: sandbox.lastRunAt?.toISOString() ?? null,
    })),
    projectSecrets: projectSecretRows(
      sandboxes.map(({ name, newest }) => ({ name, secrets: secretNamesOf(newest.config) })),
      secrets,
    ),
  };
}

/** One sandbox: its versions, its runs and the source of each secret. Null: no such sandbox. */
export async function loadSandboxDetail(
  projectId: string,
  name: string,
  canEdit: boolean,
  deps: ServerDeps & {
    versions: Pick<VersionStore, "list">;
    secrets: Pick<SecretStore, "list">;
    runs: Pick<RunStore, "list">;
  },
): Promise<SandboxDetailModel | null> {
  const [versions, runs, atProject, atSandbox] = await Promise.all([
    deps.versions.list(projectId, VERSIONS, { sandboxName: name }),
    // The runs that a person tried. The runs of eval trials are on their eval.
    deps.runs.list(projectId, RUNS, { excludeEvalTrials: true, sandboxName: name }),
    deps.secrets.list(projectId, null),
    deps.secrets.list(projectId, name),
  ]);
  const newest = versions[0];
  if (!newest) return null;
  const declared = secretNamesOf(newest.config);
  const updatedAt = (rows: typeof atProject, secret: string) =>
    rows.find((row) => row.name === secret)?.updatedAt.toISOString() ?? null;
  const sources = secretSources(declared, [
    ...atProject.map((row) => ({ name: row.name, sandboxName: null })),
    ...atSandbox.map((row) => ({ name: row.name, sandboxName: name })),
  ]);
  return {
    ...serverState(projectId, canEdit, deps),
    name,
    versions: versions.map(versionRow),
    runs: runs.map((run: SandboxRun) => runView(run)),
    secrets: sources.map(({ name: secret, source }) => ({
      name: secret,
      source,
      updatedAt:
        source === "sandbox"
          ? updatedAt(atSandbox, secret)
          : source === "project"
            ? updatedAt(atProject, secret)
            : null,
    })),
    undeclared: atSandbox
      .filter((row) => !declared.includes(row.name))
      .map((row) => ({ name: row.name, updatedAt: row.updatedAt.toISOString() })),
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
    network: config.network?.allow ?? [],
    secrets: secretNamesOf(config),
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

/** The project values and the names that a sandbox declares, the names with no value first. */
export function projectSecretRows(
  sandboxes: ReadonlyArray<{ name: string; secrets: readonly string[] }>,
  secrets: ReadonlyArray<{ name: string; updatedAt: Date }>,
): ProjectSecretRow[] {
  const declaredBy = new Map<string, string[]>();
  for (const sandbox of sandboxes) {
    for (const name of sandbox.secrets)
      declaredBy.set(name, [...(declaredBy.get(name) ?? []), sandbox.name]);
  }
  const set = new Map(secrets.map((secret) => [secret.name, secret.updatedAt.toISOString()]));
  return [...new Set([...declaredBy.keys(), ...set.keys()])]
    .map((name) => ({
      name,
      updatedAt: set.get(name) ?? null,
      declaredBy: [...(declaredBy.get(name) ?? [])].sort(),
    }))
    .sort(
      (a, b) =>
        Number(a.updatedAt !== null) - Number(b.updatedAt !== null) || (a.name < b.name ? -1 : 1),
    );
}

function serverState(projectId: string, canEdit: boolean, deps: ServerDeps): ServerState {
  return { projectId, configured: deps.configured(), problems: deps.problems(), canEdit };
}
