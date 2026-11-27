import type { z } from "zod";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import type { ResolvedApiKeyProject } from "@/lib/platform/api-key-bearer";
import type { ApiKeyPolicy } from "@/lib/platform/api-keys/policy";
import {
  EVAL_TRIAL_PREFIX,
  type SandboxRun,
  sandboxRunView,
  startRunRequestSchema,
} from "./domain/run";
import type { SandboxVersion } from "./domain/version";
import { sandboxesHref, sandboxHref } from "./paths";
import type { VersionStore } from "./ports/version-store";
import { requestOrigin } from "./push-api";
import { getRun, type RunDeps, type StartRunResult, startRun } from "./runs";

/**
 * The runs API (`protocol/sandbox/v1`, `ratel run`): start a run of the newest ready version of a
 * sandbox name, or of a version, and read it. Each call acts on the project of its key.
 */
export type SandboxRunsApiDeps = {
  /** True when no project of the deployment can have the flag: the route then answers 404 first. */
  offForAll: () => boolean;
  authenticate: () => Promise<ResolvedApiKeyProject>;
  enabled: (projectId: string) => Promise<boolean>;
  organizationIdOf: (projectId: string) => Promise<string | null>;
  versions: () => Pick<VersionStore, "get" | "newestReady">;
  runDeps: () => RunDeps;
  /** The configured public origin of this deployment, or null when none is configured. */
  publicOrigin: () => string | null;
  /** Whether the project lets Ratel read captured text. */
  contentOptIn: (projectId: string) => Promise<boolean>;
};

type Refusal = Exclude<StartRunResult, { ok: true }>;

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const STATUS: Record<Refusal["reason"], number> = {
  not_found: 404,
  not_ready: 409,
  not_configured: 503,
  missing_secrets: 409,
  input_too_large: 413,
  invalid: 400,
  limit_reached: 429,
};

export function handleStartSandboxRun(req: Request, deps: SandboxRunsApiDeps): Promise<Response> {
  return forProject(deps, "start_sandbox_run", async ({ projectId, apiKeyId }) => {
    const body = startRunRequestSchema.safeParse(await readJson(req));
    if (!body.success) return json(400, refusal("invalid", issueText(body.error.issues[0])));
    const { name, versionId, input, params, tools } = body.data;
    const version = await findVersion(deps, projectId, { name, versionId });
    if (!version) {
      const message = name
        ? `There is no ready version of the sandbox ${name}.`
        : "There is no such version.";
      return json(404, refusal("not_found", message));
    }
    const organizationId = await deps.organizationIdOf(projectId);
    if (!organizationId) return notFound();
    const started = await startRun(
      version.id,
      input,
      {
        projectId,
        organizationId,
        requestedBy: `key:${apiKeyId}`,
        ...(params ? { params } : {}),
        ...(tools ? { tools } : {}),
        strict: true,
      },
      deps.runDeps(),
    );
    if (started.ok) return json(202, view(req, started.run, version.name, deps));
    return refused(started);
  });
}

export function handleGetSandboxRun(
  req: Request,
  runId: string,
  deps: SandboxRunsApiDeps,
): Promise<Response> {
  return forProject(deps, "get_sandbox_run", async ({ projectId, apiKeyId, policy }) => {
    const run = UUID.test(runId) ? await getRun(projectId, runId, deps.runDeps()) : null;
    if (!run) return json(404, refusal("not_found", "There is no such run."));
    const version = await deps.versions().get(projectId, run.versionId);
    const shown = view(req, run, version?.name ?? null, deps);
    if (await mayReadRun(run, { projectId, apiKeyId, policy }, deps)) return json(200, shown);
    const { input: _input, output: _output, toolCalls: _calls, logs: _logs, ...rest } = shown;
    return json(200, { ...rest, contentWithheld: true });
  });
}

/**
 * The input, output, tool calls and logs of a run that a trial of an eval started are captured
 * text (a dataset row from a trace). A key reads them with `content:read` and the project's
 * opt-in, as the MCP tools do. Any other run (`ratel run`, the Playground) shows them.
 */
async function mayReadRun(
  run: SandboxRun,
  caller: { projectId: string; apiKeyId: string; policy: ApiKeyPolicy },
  deps: Pick<SandboxRunsApiDeps, "contentOptIn">,
): Promise<boolean> {
  if (!run.requestedBy.startsWith(EVAL_TRIAL_PREFIX)) return true;
  if (!caller.policy.allows("content:read")) return false;
  try {
    return await deps.contentOptIn(caller.projectId);
  } catch {
    return false;
  }
}

type Caller = { projectId: string; apiKeyId: string; policy: ApiKeyPolicy };

async function forProject(
  deps: SandboxRunsApiDeps,
  operation: string,
  work: (caller: Caller) => Promise<Response>,
): Promise<Response> {
  if (deps.offForAll()) return notFound();
  const resolved = await deps.authenticate();
  if (!resolved.ok) return resolved.response;
  const { projectId, apiKeyId, policy } = resolved;
  if (!(await deps.enabled(projectId))) return notFound();
  return withFeatureSpan("sandboxes", operation, () => work({ projectId, apiKeyId, policy }), {
    attributes: { "project.id": projectId },
  });
}

/** A version id names one version. A name runs the newest version of it that is ready. */
async function findVersion(
  deps: SandboxRunsApiDeps,
  projectId: string,
  { name, versionId }: { name?: string; versionId?: string },
): Promise<SandboxVersion | null> {
  if (versionId !== undefined) {
    return UUID.test(versionId) ? deps.versions().get(projectId, versionId) : null;
  }
  return name ? deps.versions().newestReady(projectId, name) : null;
}

/** The run, with the address of the Playground of its sandbox (the list when the version is gone). */
function view(req: Request, run: SandboxRun, sandboxName: string | null, deps: SandboxRunsApiDeps) {
  const origin = requestOrigin(req, deps.publicOrigin());
  const page = sandboxName ? sandboxHref(run.projectId, sandboxName) : sandboxesHref(run.projectId);
  return sandboxRunView(run, `${origin}${page}`);
}

function refused(started: Refusal): Response {
  const status = STATUS[started.reason];
  if (started.reason !== "limit_reached") {
    return json(status, refusal(started.reason, started.message));
  }
  const { limit, max, current, message } = started;
  return json(status, { error: "limit_reached", message, limit, max, current });
}

async function readJson(req: Request): Promise<unknown> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_JSON_BYTES) return null;
  const text = await req.text().catch(() => "");
  if (text.length > MAX_JSON_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The first issue of a refused body, with its path, e.g. `params.tone: ...`. */
function issueText(issue: z.core.$ZodIssue | undefined): string {
  if (!issue) return "The body is not a start-run request.";
  const where = issue.path.map(String).join(".");
  return `${where ? `${where}: ` : ""}${issue.message}`;
}

function notFound(): Response {
  return json(404, refusal("not_found", "Not found."));
}

function refusal(error: string, message: string) {
  return { error, message };
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}
