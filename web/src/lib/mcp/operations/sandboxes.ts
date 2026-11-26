import { z } from "zod";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { invalidParams, McpOperationError, notFound } from "@/lib/mcp/errors";
import { projectScoped, uuidParam } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { capRows, truncateText } from "@/lib/mcp/serialize";
import { getProjectById } from "@/lib/platform/projects/queries";
import {
  getRun,
  getSandboxVersionDetail,
  listSandboxVersionDetails,
  newestReadySandboxVersion,
  type SandboxRun,
  type SandboxVersionDetail,
  type StartRunOptions,
  type StartRunResult,
  sandboxRunStatus,
  startRun,
} from "@/lib/views/sandboxes";

/**
 * The Ratel sandbox tools (decision `mcp-surface`): find a pushed version of an agent, read how to
 * call it, run it with an input and read the output. They call only the public interface of
 * `views/sandboxes`.
 *
 * A call is stateless and must answer in 60 seconds. So `sandbox_run` waits a short time for the
 * result, then returns the run id and a hint to poll `sandbox_get_run`.
 */
export interface SandboxOperationDeps {
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
}

/** How long `sandbox_run` waits for the result. It stays far below the 60 second limit of a call. */
export const RUN_WAIT_MS = 25_000;
const POLL_MS = 1_000;
/** The end of the logs that a run result keeps. */
export const LOG_CHARS = 4_000;
const MAX_TOOL_CALLS = 50;
const TOOL_CALL_CHARS = 2_000;
const VERSIONS_READ = 100;
const VERSIONS_PER_SANDBOX = 5;
const ACTIVE = new Set(["queued", "running"]);

const defaultDeps: SandboxOperationDeps = {
  listVersions: listSandboxVersionDetails,
  getVersion: getSandboxVersionDetail,
  newestReady: newestReadySandboxVersion,
  startRun,
  getRun,
  organizationIdOf: async (projectId) => (await getProjectById(projectId))?.organizationId ?? null,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
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
      title: "List Ratel sandboxes",
      description:
        "Use this tool to find the agents that are pushed to Ratel sandbox. It returns each sandbox name with its newest versions, their status and the newest ready version id. Use that id with sandbox_get_version or sandbox_run.",
      keywords: ["sandbox", "pushed agents", "sandbox versions"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
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
      title: "Read a Ratel sandbox version",
      description:
        "Use this tool before sandbox_run to read how to call a version. It returns the status, the input example and schema, the declared params with their types and options, the tools with their modes, and the smoke check result.",
      keywords: ["sandbox", "declared params", "input example", "smoke check"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, versionId: versionIdParam }),
      async execute(ctx, params) {
        const version = await deps.getVersion(ctx.projectId, params.versionId);
        if (!version) throw notFound("sandbox version");
        const view = versionView(version);
        return {
          data: view,
          ...(view.smoke?.logs.truncated ? { truncated: true } : {}),
          hint:
            version.status === "ready"
              ? `Call sandbox_run with versionId "${version.id}", an input like input.example, and only the params in params.`
              : `This version is ${version.status}. Only a ready version runs. Call sandbox_list to find a ready version.`,
        };
      },
    }),
    defineOperation({
      id: "sandbox_run",
      domain: "sandboxes",
      title: "Run a Ratel sandbox version",
      description:
        "Use this tool to run a ready sandbox version with one input. This tool changes data: it starts a VM run. It waits up to 25 seconds. Then it returns the run with its input, output and tool calls, or the run id and a hint to poll sandbox_get_run.",
      keywords: ["sandbox", "run agent", "try an input"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        versionId: versionIdParam.optional(),
        name: z
          .string()
          .min(1)
          .max(63)
          .optional()
          .describe(
            "The name of a sandbox. It runs the newest ready version. Give this or versionId.",
          ),
        input: z
          .unknown()
          .describe(
            "The input of the agent. Use the shape of input.example of sandbox_get_version.",
          ),
        params: z
          .record(z.string(), scalar)
          .optional()
          .describe("Values for the params that the version declares. Other names are refused."),
      }),
      async execute(ctx, params) {
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
        return runResult(run);
      },
    }),
    defineOperation({
      id: "sandbox_get_run",
      domain: "sandboxes",
      title: "Read a Ratel sandbox run",
      description:
        "Use this tool to read a sandbox run after sandbox_run returns its run id. It returns the status, the input, the output, the params, the tool calls, the error of a failed run and the end of the container logs.",
      keywords: ["sandbox", "run result", "container logs"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        runId: uuidParam().describe("The id of a run. sandbox_run gives it."),
      }),
      async execute(ctx, params) {
        const run = await deps.getRun(ctx.projectId, params.runId);
        if (!run) throw notFound("sandbox run");
        return runResult(run);
      },
    }),
  ];
}

// — Helpers ——————————————————————————————————————————————————————————————————

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

/** Input and output first: they are what the agent asked for. The rest explains them. */
function runResult(run: SandboxRun) {
  const status = sandboxRunStatus(run.status);
  const logs = tail(run.logs);
  const toolCalls = capRows(toolCallsOf(run), MAX_TOOL_CALLS);
  let truncated = logs.truncated || toolCalls.truncated;
  const calls = toolCalls.rows.map((call) => {
    const view = capJson(call);
    truncated ||= view.truncated;
    return view.value;
  });
  const active = ACTIVE.has(run.status);
  return {
    data: {
      runId: run.id,
      status,
      input: run.request.input,
      output: run.result?.output ?? run.response?.output ?? null,
      ...(status === "failed"
        ? {
            error: {
              code: run.errorCode ?? "run_failed",
              message: run.reason ?? "The run failed.",
            },
          }
        : {}),
      params: run.request.params,
      toolCalls: calls,
      ...(toolCalls.truncated ? { toolCallCount: toolCallsOf(run).length } : {}),
      logs,
      versionId: run.versionId,
      durationMs: run.durationMs,
      traceId: run.traceId,
      createdAt: run.createdAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    },
    ...(truncated ? { truncated: true } : {}),
    hint: active
      ? `The run is ${run.status}. Call sandbox_get_run with runId "${run.id}" in a few seconds.`
      : status === "failed"
        ? "The run failed. Read error and logs. Call sandbox_get_version to check the input and params."
        : `The run is complete. To run it again with another input, call sandbox_run.`,
  };
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
