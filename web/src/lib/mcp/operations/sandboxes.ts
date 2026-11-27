import { z } from "zod";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { invalidParams, McpOperationError, notFound } from "@/lib/mcp/errors";
import {
  CONTENT_WITHHELD_HINT,
  defaultContentAccessDeps,
  mayReadContent,
} from "@/lib/mcp/operations/content-access";
import { projectScoped, uuidParam } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation, type OperationContext } from "@/lib/mcp/registry";
import { capRows, truncateText } from "@/lib/mcp/serialize";
import { getProjectById } from "@/lib/platform/projects/queries";
import {
  getRun,
  getSandboxVersionDetail,
  listSandboxVersionDetails,
  newestReadySandboxVersion,
  type SandboxRun,
  type SandboxSecretSource,
  type SandboxVersionDetail,
  type StartRunOptions,
  type StartRunResult,
  sandboxesEnabledForProject,
  sandboxRunStatus,
  sandboxSecretSources,
  startRun,
} from "@/lib/views/sandboxes";

/**
 * The Sandboxes tools (decision `mcp-surface`): find a pushed version of an agent, read how to
 * call it, run it with an input and read the output. They call only the public interface of
 * `views/sandboxes`. They are listed only for a caller with the `evals` flag (one flag for the
 * sandbox and the evals), and each call checks the flag for its project again.
 *
 * A call is stateless and must answer in 60 seconds. So `sandbox_run` waits a short time for the
 * result, then returns the run id and a hint to poll `sandbox_get_run`.
 */
export interface SandboxOperationDeps {
  enabled(projectId: string): Promise<boolean>;
  /** The newest first. */
  listVersions(projectId: string, limit: number): Promise<SandboxVersionDetail[]>;
  getVersion(projectId: string, versionId: string): Promise<SandboxVersionDetail | null>;
  newestReady(projectId: string, name: string): Promise<SandboxVersionDetail | null>;
  startRun(versionId: string, input: unknown, options: StartRunOptions): Promise<StartRunResult>;
  getRun(projectId: string, runId: string): Promise<SandboxRun | null>;
  /** The organization of a project, when the credential does not name it. */
  organizationIdOf?(projectId: string): Promise<string | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** The content rule of `content-access.ts`: run inputs, outputs and logs are captured text. */
  mayReadContent(ctx: Pick<OperationContext, "auth" | "projectId">): Promise<boolean>;
  /** Where the value of each declared secret comes from. Never a value. */
  secretSources(
    projectId: string,
    sandboxName: string,
    names: readonly string[],
  ): Promise<Array<{ name: string; source: SandboxSecretSource }>>;
}

/** How long `sandbox_run` waits for the result. It stays far below the 60 second limit of a call. */
export const RUN_WAIT_MS = 25_000;
const POLL_MS = 1_000;
/** The end of the logs that a run result keeps. */
export const LOG_CHARS = 4_000;
const MAX_TOOL_CALLS = 50;
const TOOL_CALL_CHARS = 2_000;
/** The input and the output of a run keep this many characters. */
const VALUE_CHARS = 8_000;
const VERSIONS_READ = 100;
const VERSIONS_PER_SANDBOX = 5;
const ACTIVE = new Set(["queued", "running"]);

const defaultDeps: SandboxOperationDeps = {
  enabled: (projectId) => sandboxesEnabledForProject(projectId),
  listVersions: listSandboxVersionDetails,
  getVersion: getSandboxVersionDetail,
  newestReady: newestReadySandboxVersion,
  startRun,
  getRun,
  organizationIdOf: async (projectId) => (await getProjectById(projectId))?.organizationId ?? null,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  mayReadContent: (ctx) => mayReadContent(ctx, defaultContentAccessDeps),
  secretSources: sandboxSecretSources,
};

const versionIdParam = uuidParam().describe(
  "The id of a version. sandbox_list gives the version ids.",
);
const scalar = z.union([z.string(), z.number(), z.boolean()]);

export function sandboxOperations(deps: SandboxOperationDeps = defaultDeps): McpOperation[] {
  return [
    defineOperation({
      id: "sandbox_list",
      domain: "sandboxes",
      title: "List sandboxes",
      description:
        "Use this tool to find the agents that you pushed to Ratel (the sandboxes). It returns each sandbox name and its newest versions with their status. It also returns the newest ready version id. Use that id with sandbox_get_version or sandbox_run.",
      keywords: ["sandbox", "pushed agents", "sandbox versions"],
      scope: "project",
      mutates: false,
      apiKeyScope: "sandboxes:read",
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        await requireSandboxes(deps, ctx.projectId);
        const versions = await deps.listVersions(ctx.projectId, VERSIONS_READ + 1);
        const read = capRows(versions, VERSIONS_READ);
        const sandboxes = groupByName(read.rows);
        return {
          data: { sandboxes },
          ...(read.truncated ? { truncated: true } : {}),
          hint:
            sandboxes.length === 0
              ? "This project has no sandbox. Push an agent image with `ratel push`, then call sandbox_list again."
              : "Call sandbox_get_version with a versionId to read its input example and params before you call sandbox_run.",
        };
      },
    }),
    defineOperation({
      id: "sandbox_get_version",
      domain: "sandboxes",
      title: "Read a sandbox version",
      description:
        "Use this tool before sandbox_run to read how to call a version. It returns the status, the input example and schema, and the smoke check result. It also returns the declared params with their types and options, the tools with their modes, and the declared secrets with their source: sandbox, project or missing. It never returns a secret value.",
      keywords: ["sandbox", "declared params", "input example", "smoke check"],
      scope: "project",
      mutates: false,
      apiKeyScope: "sandboxes:read",
      params: z.object({ ...projectScoped, versionId: versionIdParam }),
      async execute(ctx, params) {
        await requireSandboxes(deps, ctx.projectId);
        const version = await deps.getVersion(ctx.projectId, params.versionId);
        if (!version) throw notFound("sandbox version");
        const secrets = await deps.secretSources(
          ctx.projectId,
          version.name,
          version.config.secrets ?? [],
        );
        const view = { ...versionView(version), secrets };
        const missing = secrets
          .filter(({ source }) => source === "missing")
          .map(({ name }) => name);
        return {
          data: view,
          ...(view.smoke?.logs.truncated ? { truncated: true } : {}),
          hint:
            version.status !== "ready"
              ? `This version is ${version.status}. Only a ready version runs. Call sandbox_list to find a ready version.`
              : missing.length > 0
                ? `A run is refused until these secrets are set for the sandbox or the project on the Sandboxes page: ${missing.join(", ")}.`
                : `Call sandbox_run with versionId "${version.id}", an input like input.example, and only the params in params.`,
        };
      },
    }),
    defineOperation({
      id: "sandbox_run",
      domain: "sandboxes",
      title: "Run a sandbox version",
      description:
        "Use this tool to run a ready sandbox version with one input. This tool changes data: it starts a VM run. It waits up to 25 seconds. It returns the run id and the status. A complete run also has the input, the output and the tool calls. For a run that is not complete, call sandbox_get_run.",
      keywords: ["sandbox", "run agent", "try an input"],
      scope: "project",
      mutates: true,
      apiKeyScope: "sandboxes:run",
      params: z.object({
        ...projectScoped,
        versionId: versionIdParam.optional(),
        name: z
          .string()
          .min(1)
          .max(63)
          .optional()
          .describe(
            "The name of a sandbox. The tool runs its newest ready version. Give this or versionId.",
          ),
        input: z
          .unknown()
          .describe(
            "The input of the agent. Use the shape of input.example of sandbox_get_version.",
          ),
        params: z
          .record(z.string(), scalar)
          .optional()
          .describe(
            "Values for the params that the version declares. The tool refuses other names.",
          ),
      }),
      async execute(ctx, params) {
        await requireSandboxes(deps, ctx.projectId);
        const version = await findVersion(deps, ctx.projectId, params);
        refuseUndeclared(version, params.params ?? {});
        const organizationId =
          ctx.organizationId ?? (await deps.organizationIdOf?.(ctx.projectId)) ?? null;
        if (!organizationId) throw notFound("project");
        const started = await deps.startRun(version.id, params.input ?? null, {
          projectId: ctx.projectId,
          organizationId,
          requestedBy: requester(ctx.auth),
          ...(params.params ? { params: params.params } : {}),
          strict: true,
        });
        if (!started.ok) throw refusal(started);
        const run = await waitForEnd(deps, ctx.projectId, started.run);
        return runResult(run, await deps.mayReadContent(ctx));
      },
    }),
    defineOperation({
      id: "sandbox_get_run",
      domain: "sandboxes",
      title: "Read a sandbox run",
      description:
        "Use this tool to read a sandbox run after sandbox_run returns its run id. It returns the status, the input, the output and the params. It also returns the tool calls, the error of a failed run and the end of the container logs.",
      keywords: ["sandbox", "run result", "container logs"],
      scope: "project",
      mutates: false,
      apiKeyScope: "sandboxes:read",
      params: z.object({
        ...projectScoped,
        runId: uuidParam().describe("The id of a run. sandbox_run gives it."),
      }),
      async execute(ctx, params) {
        await requireSandboxes(deps, ctx.projectId);
        const run = await deps.getRun(ctx.projectId, params.runId);
        if (!run) throw notFound("sandbox run");
        return runResult(run, await deps.mayReadContent(ctx));
      },
    }),
  ];
}

// — Helpers ——————————————————————————————————————————————————————————————————

async function requireSandboxes(deps: SandboxOperationDeps, projectId: string): Promise<void> {
  if (await deps.enabled(projectId)) return;
  throw new McpOperationError("forbidden", "Sandboxes are not on for this project.", {
    reason: "sandboxes_off",
  });
}

function groupByName(versions: readonly SandboxVersionDetail[]) {
  const byName = new Map<string, SandboxVersionDetail[]>();
  for (const version of versions) {
    byName.set(version.name, [...(byName.get(version.name) ?? []), version]);
  }
  return [...byName.entries()].map(([name, rows]) => ({
    name,
    newestReadyVersionId: rows.find((row) => row.status === "ready")?.id ?? null,
    versionCount: rows.length,
    versions: rows.slice(0, VERSIONS_PER_SANDBOX).map((row) => ({
      versionId: row.id,
      status: row.status,
      commit: row.git?.commit.slice(0, 12) ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
  }));
}

function versionView(version: SandboxVersionDetail) {
  const { config, smoke } = version;
  return {
    versionId: version.id,
    name: version.name,
    status: version.status,
    ...(version.reason ? { reason: version.reason } : {}),
    input: {
      example: config.input?.example ?? null,
      ...(config.input?.schema ? { schema: config.input.schema } : {}),
    },
    params: Object.entries(config.params ?? {}).map(([name, param]) => ({ name, ...param })),
    tools: Object.entries(config.tools ?? {}).map(([name, tool]) => ({
      name,
      mode: tool.mode ?? "simulated",
    })),
    timeoutSeconds: config.run?.timeoutSeconds ?? null,
    smoke: smoke
      ? {
          ok: smoke.ok,
          ...(smoke.ok ? { output: smoke.output } : { error: smoke.error }),
          durationMs: smoke.durationMs,
          logs: tail(smoke.logs),
        }
      : null,
    git: version.git,
    createdAt: version.createdAt.toISOString(),
  };
}

async function findVersion(
  deps: SandboxOperationDeps,
  projectId: string,
  params: { versionId?: string | undefined; name?: string | undefined },
): Promise<SandboxVersionDetail> {
  if (params.versionId) {
    const version = await deps.getVersion(projectId, params.versionId);
    if (!version) throw notFound("sandbox version");
    return version;
  }
  if (!params.name) {
    throw invalidParams("Give a versionId or the name of a sandbox. sandbox_list gives both.", [
      { path: "versionId", message: "Give a versionId or a name." },
    ]);
  }
  const version = await deps.newestReady(projectId, params.name);
  if (!version) throw notFound(`ready version of the sandbox "${params.name.slice(0, 63)}"`);
  return version;
}

/** An agent guesses param names. The refusal names the declared ones, so the next call is right. */
function refuseUndeclared(version: SandboxVersionDetail, params: Record<string, unknown>): void {
  const declared = Object.keys(version.config.params ?? {});
  const unknown = Object.keys(params).filter((name) => !declared.includes(name));
  if (unknown.length === 0) return;
  const names = unknown.map((name) => name.slice(0, 64)).join(", ");
  const message =
    declared.length === 0
      ? `This version declares no params. Remove these params: ${names}.`
      : `This version does not declare these params: ${names}. The declared params are: ${declared.join(", ")}.`;
  throw invalidParams(
    message,
    unknown.map((name) => ({ path: `params.${name.slice(0, 64)}`, message: "Not declared." })),
  );
}

function requester(auth: McpAuthContext): string {
  return auth.kind === "api-key" ? `mcp:key:${auth.apiKeyId}` : `mcp:user:${auth.userId}`;
}

const REFUSAL_CODE = {
  not_found: "not_found",
  not_ready: "conflict",
  not_configured: "unavailable",
  missing_secrets: "conflict",
  input_too_large: "invalid_params",
  invalid: "invalid_params",
  limit_reached: "quota_exceeded",
} as const;

function refusal(started: Exclude<StartRunResult, { ok: true }>): McpOperationError {
  return new McpOperationError(REFUSAL_CODE[started.reason], started.message, {
    reason: started.reason,
  });
}

async function waitForEnd(
  deps: SandboxOperationDeps,
  projectId: string,
  started: SandboxRun,
): Promise<SandboxRun> {
  const deadline = deps.now() + RUN_WAIT_MS;
  let run = started;
  while (ACTIVE.has(run.status) && deps.now() < deadline) {
    await deps.sleep(POLL_MS);
    run = (await deps.getRun(projectId, run.id)) ?? run;
  }
  return run;
}

/**
 * Input and output first: they are what the agent asked for. The rest explains them. Without
 * content access the captured text (input, output, params, tool call data, logs) is null.
 */
function runResult(run: SandboxRun, readable: boolean) {
  const status = sandboxRunStatus(run.status);
  const logs = readable ? tail(run.logs) : { text: null, truncated: false };
  const toolCalls = capRows(toolCallsOf(run), MAX_TOOL_CALLS);
  const input = readable ? preview(run.request.input) : { value: null, truncated: false };
  const output = readable
    ? preview(run.result?.output ?? run.response?.output ?? null)
    : { value: null, truncated: false };
  let truncated = logs.truncated || toolCalls.truncated || input.truncated || output.truncated;
  const calls = toolCalls.rows.map((call) => {
    if (!readable) return { name: call.name, source: call.source ?? call.mode ?? null };
    const view = capJson(call);
    truncated ||= view.truncated;
    return view.value;
  });
  const active = ACTIVE.has(run.status);
  const hint = active
    ? `The run is ${run.status}. Call sandbox_get_run with runId "${run.id}" again in a few seconds.`
    : status === "failed"
      ? "The run failed. Read error and logs. Call sandbox_get_version to check the input and params."
      : "The run is complete. To run it again with another input, call sandbox_run.";
  return {
    data: {
      runId: run.id,
      status,
      input: input.value,
      output: output.value,
      ...(status === "failed"
        ? {
            error: {
              code: run.errorCode ?? "run_failed",
              message: readable ? (run.reason ?? "The run failed.") : null,
            },
          }
        : {}),
      params: readable ? run.request.params : null,
      toolCalls: calls,
      ...(toolCalls.truncated ? { toolCallCount: toolCallsOf(run).length } : {}),
      logs,
      versionId: run.versionId,
      durationMs: run.durationMs,
      traceId: run.traceId,
      createdAt: run.createdAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      ...(readable ? {} : { contentWithheld: true }),
    },
    ...(truncated ? { truncated: true } : {}),
    hint: readable ? hint : `${hint} ${CONTENT_WITHHELD_HINT}`,
  };
}

/** A JSON value as it is when it is small, else a text preview of it. */
function preview(value: unknown): { value: unknown; truncated: boolean } {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (text.length <= VALUE_CHARS) return { value, truncated: false };
  return { value: truncateText(text, VALUE_CHARS).text, truncated: true };
}

function toolCallsOf(run: SandboxRun): ReadonlyArray<Record<string, unknown>> {
  if (run.result) return run.result.toolCalls;
  return (run.response?.toolCalls ?? []) as ReadonlyArray<Record<string, unknown>>;
}

/** The end of a log: the error is usually last. */
function tail(text: string | null | undefined): { text: string; truncated: boolean } {
  if (!text) return { text: "", truncated: false };
  if (text.length <= LOG_CHARS) return { text, truncated: false };
  return { text: `…${text.slice(text.length - LOG_CHARS)}`, truncated: true };
}

/** A tool call with large arguments or result keeps a preview of each. */
function capJson(call: Record<string, unknown>): { value: unknown; truncated: boolean } {
  if (JSON.stringify(call).length <= TOOL_CALL_CHARS) return { value: call, truncated: false };
  const preview = (value: unknown) =>
    value === undefined ? undefined : truncateText(JSON.stringify(value), TOOL_CALL_CHARS / 2).text;
  return {
    value: {
      ...call,
      arguments: preview(call.arguments ?? call.args),
      ...(call.result !== undefined ? { result: preview(call.result) } : {}),
      truncated: true,
    },
    truncated: true,
  };
}
