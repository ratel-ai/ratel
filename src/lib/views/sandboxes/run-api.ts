import { z } from "zod";
import { getLogger } from "@/lib/platform/logger";
import type { RecordedItem, RecordedItemsQuery, TraceMetrics } from "./adapters/recorded-items";
import type { RunNotifications } from "./adapters/run-notifications";
import { isTerminalStatus } from "./domain/run";
import { argsKey } from "./fakes/domain/fake";
import type { FakeStore } from "./fakes/ports/fake-store";
import type { SandboxRunStore } from "./ports/store";
import { checkCompareSelection, MAX_COMPARE_ITEMS } from "./replay";
import { checkRunRequest, findManifestSandbox } from "./run-request";

/**
 * The session-authenticated sandbox run API (RC-1100), under
 * `/api/projects/<id>/sandboxes/…`. A signed-in member of the project lists its
 * runners, starts a run on their OWN runner, cancels it and follows its events
 * over SSE. With cloud-sandboxes off for the project every route is not found.
 */

export interface SandboxRunApiDeps {
  getSession: () => Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope: (
    projectId: string,
    userId: string,
  ) => Promise<{ project: { id: string }; organization: { id: string } } | null>;
  sandboxesEnabled: (projectId: string) => Promise<boolean>;
  store: () => SandboxRunStore;
  /** Session pins of fake values (RC-1108). */
  fakeStore: () => FakeStore;
  /** A sandbox's recorded production items (RC-1103). */
  recordedItems: (query: RecordedItemsQuery) => Promise<RecordedItem[]>;
  /** The tokens, cost and latency of a run's trace (RC-1103). */
  traceMetrics: (query: { projectId: string; traceId: string }) => Promise<TraceMetrics>;
  now?: () => Date;
  notifications: () => RunNotifications;
  track: (
    event:
      | "sandbox_run_started"
      | "sandbox_run_cancelled"
      | "sandbox_tool_confirmed"
      | "sandbox_fake_pinned"
      | "sandbox_fake_unpinned",
    context: { externalId: string; projectId: string; orgId: string },
    properties: Record<string, unknown>,
  ) => Promise<void>;
  /** SSE timing; tests shorten them. */
  pollIntervalMs?: number;
  pingIntervalMs?: number;
}

interface Caller {
  externalId: string;
  projectId: string;
  organizationId: string;
}

const logger = getLogger("sandboxes/run-api");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "cache-control": "private, no-store" };
const TRACE_ID = /^[0-9a-f]{32}$/i;
const SPAN_ID = /^[0-9a-f]{1,64}$/i;
/** The recorded items list reads at most this many. */
const MAX_ITEMS_LIST = 200;

const StartBody = z.object({
  runnerId: z.string().regex(UUID),
  sandboxId: z.string().min(1).max(128),
  sessionId: z.string().regex(UUID).optional(),
  input: z.unknown(),
  params: z.record(z.string(), z.unknown()).default({}),
  toolModes: z.record(z.string(), z.enum(["real", "fake", "confirm"])).default({}),
  context: z.record(z.string(), z.unknown()).default({}),
  /** A replay of a recorded item: the runner stamps it as `ratel.replay.*` on the run's root. */
  replay: z
    .object({
      sourceTraceId: z.string().regex(TRACE_ID).optional(),
      sourceSessionId: z.string().min(1).max(256).optional(),
      arm: z.enum(["baseline", "candidate"]).optional(),
    })
    .strict()
    .optional(),
});

/** A pinned or reviewer-supplied value fits one sandbox/v1 frame with room for its envelope. */
const MAX_VALUE_BYTES = 48_000;
const JsonValue = z
  .unknown()
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value ?? null), "utf8") <= MAX_VALUE_BYTES,
    "is too large",
  );

const ConfirmBody = z
  .object({
    callId: z.string().min(1).max(256),
    decision: z.enum(["approve", "edit", "fake", "reject"]),
    args: JsonValue.optional(),
    result: JsonValue.optional(),
  })
  .refine((body) => body.decision !== "edit" || body.args !== undefined, {
    message: "args is required to edit and approve",
  })
  .refine((body) => body.decision !== "fake" || body.result !== undefined, {
    message: "result is required to fake",
  });

const PinBody = z.object({
  sessionId: z.string().regex(UUID),
  tool: z.string().min(1).max(256),
  args: z.unknown(),
  result: JsonValue,
  isError: z.boolean().default(false),
});

const UnpinBody = z.object({
  sessionId: z.string().regex(UUID),
  tool: z.string().min(1).max(256),
  args: z.unknown(),
});

const SandboxIdParam = z.string().min(1).max(128);
const ItemsLimit = z.coerce.number().int().min(1).max(MAX_ITEMS_LIST).default(50);

const CompareBody = z.object({
  sandboxId: SandboxIdParam,
  spanIds: z.array(z.string().regex(SPAN_ID)).max(MAX_COMPARE_ITEMS + 1_000),
});

/** GET runners: every runner of the project; only the caller's own online runner is startable. */
export async function handleListRunners(
  projectId: string,
  deps: SandboxRunApiDeps,
): Promise<Response> {
  const caller = await authorize(projectId, deps);
  if (caller instanceof Response) return caller;
  const runners = await deps.store().listRunners(caller.projectId);
  return json(200, {
    runners: runners.map((r) => {
      const mine = r.ownerUserId === caller.externalId;
      return {
        id: r.id,
        instanceId: r.instanceId,
        mine,
        online: r.online,
        startable: mine && r.online,
        manifest: r.manifest,
        maxConcurrency: r.maxConcurrency,
        connectedAt: r.connectedAt.toISOString(),
        lastSeenAt: r.lastSeenAt.toISOString(),
      };
    }),
  });
}

/** POST runs: checks the request against the runner's manifest, then queues the run on that runner. */
export async function handleStartRun(
  request: Request,
  projectId: string,
  deps: SandboxRunApiDeps,
): Promise<Response> {
  const caller = await authorize(projectId, deps);
  if (caller instanceof Response) return caller;
  const parsed = StartBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return json(400, {
      error: "invalid",
      message: parsed.error.issues[0]?.message ?? "Invalid run request.",
    });
  const body = parsed.data;

  const store = deps.store();
  const runner = (await store.listRunners(caller.projectId)).find((r) => r.id === body.runnerId);
  if (!runner)
    return json(404, {
      error: "runner_not_found",
      message: "No runner of this project has that ID.",
    });
  if (runner.ownerUserId !== caller.externalId) {
    return json(403, { error: "runner_not_owner", message: "A run goes only to your own runner." });
  }
  const check = checkRunRequest(
    findManifestSandbox(runner.manifest, body.sandboxId),
    body.input,
    body.params,
    body.toolModes,
  );
  if (!check.ok) {
    if (check.error === "invalid_tool_modes")
      return json(400, {
        error: "invalid_tool_modes",
        message: check.problems.join("; "),
        problems: check.problems,
      });
    if (check.error === "unknown_sandbox")
      return json(404, {
        error: "unknown_sandbox",
        message: `The runner has no sandbox "${body.sandboxId}".`,
      });
    if (check.error === "invalid_params") {
      return json(400, {
        error: "invalid_params",
        message: check.params.map((p) => `${p.param} ${p.message}`).join("; "),
        params: check.params,
      });
    }
    return json(400, { error: "invalid_input", message: check.message });
  }

  const result = await store.startRun({
    projectId: caller.projectId,
    ownerUserId: caller.externalId,
    runnerId: runner.id,
    sandboxId: body.sandboxId,
    sessionId: body.sessionId,
    input: body.input,
    params: body.params,
    toolModes: body.toolModes,
    context: body.context,
    configHash: check.configHash,
    overrides: check.overrides,
    ...(body.replay ? { replay: body.replay } : {}),
  });
  if (!result.ok) {
    const status =
      result.reason === "runner_offline" ? 409 : result.reason === "runner_not_found" ? 404 : 403;
    return json(status, { error: result.reason });
  }
  logger.info(
    { project_id: caller.projectId, run_id: result.runId, sandbox_id: body.sandboxId },
    "started sandbox run",
  );
  await deps.track("sandbox_run_started", ctx(caller), {
    sandbox_id: body.sandboxId,
    overrides: check.overrides.length,
    run_id: result.runId,
    ...(body.replay?.arm ? { replay_arm: body.replay.arm } : {}),
  });
  return json(201, {
    runId: result.runId,
    sessionId: result.sessionId,
    configHash: check.configHash,
    overrides: check.overrides,
  });
}

/** GET runs?sandboxId=: the caller's own runs of one sandbox, newest first, for the playground's run list. */
export async function handleListRuns(
  request: Request,
  projectId: string,
  deps: SandboxRunApiDeps,
): Promise<Response> {
  const caller = await authorize(projectId, deps);
  if (caller instanceof Response) return caller;
  const sandboxId = new URL(request.url).searchParams.get("sandboxId") ?? "";
  if (!sandboxId || sandboxId.length > 128)
    return json(400, { error: "invalid", message: "sandboxId is required." });
  const runs = await deps
    .store()
    .listRuns({ projectId: caller.projectId, ownerUserId: caller.externalId, sandboxId });
  return json(200, {
    runs: runs.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      runnerId: r.runnerId,
      status: r.status,
      configHash: r.configHash,
      overrides: r.overrides,
      input: r.input,
      params: r.params,
      output: r.output,
      error: r.error,
      usage: r.usage,
      traceId: r.traceId,
      createdAt: r.createdAt.toISOString(),
      endedAt: r.endedAt?.toISOString() ?? null,
    })),
  });
}

/** GET items?sandboxId=&limit=: the sandbox's recorded production items of the last 30 days, newest first (RC-1103). */
export async function handleListRecordedItems(
  request: Request,
  projectId: string,
  deps: SandboxRunApiDeps,
): Promise<Response> {
  const caller = await authorize(projectId, deps);
  if (caller instanceof Response) return caller;
  const search = new URL(request.url).searchParams;
  const sandboxId = SandboxIdParam.safeParse(search.get("sandboxId"));
  if (!sandboxId.success) return json(400, { error: "invalid", message: "sandboxId is required." });
  const limit = ItemsLimit.safeParse(search.get("limit") ?? undefined);
  if (!limit.success)
    return json(400, { error: "invalid", message: `limit is 1 to ${MAX_ITEMS_LIST}.` });
  const items = await deps.recordedItems({
    projectId: caller.projectId,
    sandboxId: sandboxId.data,
    now: now(deps),
    limit: limit.data,
  });
  return json(200, { items: items.map(itemJson) });
}

/**
 * POST compare: checks a compare selection (at most 50 items) and resolves the
 * picked items, in the order picked, for the browser's loop of single runs.
 */
export async function handleCompareItems(
  request: Request,
  projectId: string,
  deps: SandboxRunApiDeps,
): Promise<Response> {
  const caller = await authorize(projectId, deps);
  if (caller instanceof Response) return caller;
  const parsed = CompareBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return json(400, {
      error: "invalid",
      message: parsed.error.issues[0]?.message ?? "Invalid compare request.",
    });
  const refusal = checkCompareSelection(parsed.data.spanIds);
  if (refusal) return json(400, { error: "invalid_selection", message: refusal });
  const { sandboxId, spanIds } = parsed.data;
  const found = await deps.recordedItems({
    projectId: caller.projectId,
    sandboxId,
    now: now(deps),
    spanIds,
  });
  const bySpan = new Map(found.map((item) => [item.spanId, item]));
  const items = spanIds.flatMap((spanId) => {
    const item = bySpan.get(spanId);
    return item ? [{ ...itemJson(item), sourceTraceId: item.traceId }] : [];
  });
  logger.info(
    { project_id: caller.projectId, sandbox_id: sandboxId, n_items: items.length },
    "resolved sandbox compare items",
  );
  return json(200, { items, missing: spanIds.filter((spanId) => !bySpan.has(spanId)) });
}

/**
 * GET runs/<id>/metrics: the caller's run's tokens, cost and latency, read
 * from its trace. `ready` is false until the run has a trace id and its spans
 * are in (the runner exports them a few seconds after the run ends).
 */
export async function handleRunMetrics(
  projectId: string,
  runId: string,
  deps: SandboxRunApiDeps,
): Promise<Response> {
  const caller = await authorize(projectId, deps);
  if (caller instanceof Response) return caller;
  if (!UUID.test(runId)) return json(404, { error: "run_not_found" });
  const run = await deps.store().getRun(caller.projectId, runId);
  if (!run || run.ownerUserId !== caller.externalId) return json(404, { error: "run_not_found" });
  if (!run.traceId) return json(200, { ready: false, traceId: null });
  const metrics = await deps.traceMetrics({ projectId: caller.projectId, traceId: run.traceId });
  if (metrics.spans === 0) return json(200, { ready: false, traceId: run.traceId });
  return json(200, {
    ready: true,
    traceId: run.traceId,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    costUsd: metrics.costUsd,
    latencyMs: metrics.latencyMs,
  });
}

/** POST runs/<id>/cancel: a cancel for the caller's own live run. */
export async function handleCancelRun(
  projectId: string,
  runId: string,
  deps: SandboxRunApiDeps,
): Promise<Response> {
  const caller = await authorize(projectId, deps);
  if (caller instanceof Response) return caller;
  if (!UUID.test(runId)) return json(404, { error: "run_not_found" });
  const result = await deps.store().cancelRun({
    runId,
    projectId: caller.projectId,
    ownerUserId: caller.externalId,
    reason: "Canceled in the playground.",
  });
  if (!result.ok)
    return json(result.reason === "run_not_found" ? 404 : 409, { error: result.reason });
  await deps.track("sandbox_run_cancelled", ctx(caller), { run_id: runId });
  return json(202, { status: result.status });
}

/**
 * POST runs/<id>/confirm: the reviewer's decision on a confirm call of the
 * caller's own live run. It goes to the runner as `tool.confirm.decision`.
 */
export async function handleConfirmTool(
  request: Request,
  projectId: string,
  runId: string,
  deps: SandboxRunApiDeps,
): Promise<Response> {
  const caller = await authorize(projectId, deps);
  if (caller instanceof Response) return caller;
  if (!UUID.test(runId)) return json(404, { error: "run_not_found" });
  const parsed = ConfirmBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return json(400, {
      error: "invalid",
      message: parsed.error.issues[0]?.message ?? "Invalid decision.",
    });
  const result = await deps.store().decideConfirm({
    runId,
    projectId: caller.projectId,
    ownerUserId: caller.externalId,
    ...parsed.data,
  });
  if (!result.ok) {
    const status = result.reason === "run_not_found" ? 404 : 409;
    return json(status, { error: result.reason });
  }
  await deps.track("sandbox_tool_confirmed", ctx(caller), {
    run_id: runId,
    decision: parsed.data.decision,
  });
  return json(202, { ok: true });
}

/** POST pins: pins a fake value for one tool and its normalized arguments in the caller's own session. */
export async function handlePinFake(
  request: Request,
  projectId: string,
  deps: SandboxRunApiDeps,
): Promise<Response> {
  const caller = await authorize(projectId, deps);
  if (caller instanceof Response) return caller;
  const parsed = PinBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return json(400, {
      error: "invalid",
      message: parsed.error.issues[0]?.message ?? "Invalid pin.",
    });
  const { sessionId, tool, args, result, isError } = parsed.data;
  const fakes = deps.fakeStore();
  if (!(await ownsSession(fakes, sessionId, caller)))
    return json(404, { error: "session_not_found" });
  await fakes.pin({
    sessionId,
    tool,
    argsKey: argsKey(args),
    result,
    isError,
    pinnedBy: caller.externalId,
  });
  await deps.track("sandbox_fake_pinned", ctx(caller), { session_id: sessionId });
  return json(201, { ok: true });
}

/** GET pins?sessionId=: the pins of the caller's own session, newest first. */
export async function handleListPins(
  request: Request,
  projectId: string,
  deps: SandboxRunApiDeps,
): Promise<Response> {
  const caller = await authorize(projectId, deps);
  if (caller instanceof Response) return caller;
  const sessionId = new URL(request.url).searchParams.get("sessionId") ?? "";
  const fakes = deps.fakeStore();
  if (!(await ownsSession(fakes, sessionId, caller)))
    return json(404, { error: "session_not_found" });
  const pins = await fakes.pins(sessionId);
  return json(200, {
    pins: pins.map((pin) => ({
      tool: pin.tool,
      args: pin.args,
      result: pin.result,
      isError: pin.isError,
      createdAt: pin.createdAt.toISOString(),
    })),
  });
}

/** DELETE pins: removes one pin of the caller's own session (the tool and its normalized arguments). */
export async function handleUnpinFake(
  request: Request,
  projectId: string,
  deps: SandboxRunApiDeps,
): Promise<Response> {
  const caller = await authorize(projectId, deps);
  if (caller instanceof Response) return caller;
  const parsed = UnpinBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return json(400, {
      error: "invalid",
      message: parsed.error.issues[0]?.message ?? "Invalid pin.",
    });
  const { sessionId, tool, args } = parsed.data;
  const fakes = deps.fakeStore();
  if (!(await ownsSession(fakes, sessionId, caller)))
    return json(404, { error: "session_not_found" });
  if (!(await fakes.unpin(sessionId, tool, argsKey(args))))
    return json(404, { error: "pin_not_found" });
  await deps.track("sandbox_fake_unpinned", ctx(caller), { session_id: sessionId });
  return json(200, { ok: true });
}

/**
 * GET runs/<id>/events: Server-Sent Events. Replays the rows after
 * `Last-Event-ID` (or `?after=`), then sends new rows as NOTIFY wakes it, with a
 * poll as fallback, until the run has ended and every row is out. A comment
 * ping every 20 s keeps the response under the ALB idle timeout.
 */
export async function handleRunEvents(
  request: Request,
  projectId: string,
  runId: string,
  deps: SandboxRunApiDeps,
): Promise<Response> {
  const caller = await authorize(projectId, deps);
  if (caller instanceof Response) return caller;
  if (!UUID.test(runId)) return json(404, { error: "run_not_found" });
  const store = deps.store();
  if (!(await store.getRun(caller.projectId, runId))) return json(404, { error: "run_not_found" });

  const resumeFrom = Number(
    request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after") ?? 0,
  );
  let lastSeq = Number.isInteger(resumeFrom) && resumeFrom > 0 ? resumeFrom : 0;
  const pollMs = deps.pollIntervalMs ?? 3_000;
  const pingMs = deps.pingIntervalMs ?? 20_000;
  const encoder = new TextEncoder();
  let stop: () => void = () => {};

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let wake: () => void = () => {};
      // A NOTIFY that arrives while rows are being read must not be lost.
      let woken = false;
      const send = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text));
      };
      const unsubscribe = deps.notifications().subscribe(runId, () => {
        woken = true;
        wake();
      });
      const ping = setInterval(() => send(": ping\n\n"), pingMs);
      stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        unsubscribe();
        wake();
      };
      request.signal.addEventListener("abort", () => stop());
      send("retry: 3000\n\n");
      try {
        while (!closed) {
          // The store returns only the contiguous prefix, so the cursor never
          // moves past a seq that is still missing; it comes on a later read.
          const rows = await store.readEventsAfter(runId, lastSeq);
          for (const row of rows) {
            send(`id: ${row.seq}\nevent: ${row.kind}\ndata: ${JSON.stringify(row.payload)}\n\n`);
            lastSeq = row.seq;
          }
          if (rows.length > 0) continue;
          // A run is terminal only once its run.end is inside the prefix, or
          // when it was marked lost (a gap that was never repaired).
          const run = await store.getRun(caller.projectId, runId);
          if (!run || isTerminalStatus(run.status)) {
            // Re-read once: the last rows can land between the read and the status.
            if ((await store.readEventsAfter(runId, lastSeq)).length > 0) continue;
            send(
              `event: run.status\ndata: ${JSON.stringify({ status: run?.status ?? "unknown", error: run?.error ?? null })}\n\n`,
            );
            break;
          }
          if (woken) {
            woken = false;
            continue;
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, pollMs);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          woken = false;
        }
      } catch (err) {
        logger.error({ err, run_id: runId }, "sandbox event stream failed");
      } finally {
        stop();
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      }
    },
    cancel() {
      stop();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

async function authorize(projectId: string, deps: SandboxRunApiDeps): Promise<Caller | Response> {
  const session = await deps.getSession();
  if (!session) return json(401, { error: "signed_out", message: "Sign in to use sandboxes." });
  const scope = UUID.test(projectId)
    ? await deps.findProjectScope(projectId, session.user.id)
    : null;
  if (!scope || !(await deps.sandboxesEnabled(scope.project.id)))
    return json(404, { error: "not_found" });
  return {
    externalId: session.user.externalId,
    projectId: scope.project.id,
    organizationId: scope.organization.id,
  };
}

function itemJson(item: RecordedItem) {
  return {
    spanId: item.spanId,
    traceId: item.traceId,
    startedAt: item.startedAt.toISOString(),
    input: item.input,
    recordedOutput: item.recordedOutput,
  };
}

function now(deps: SandboxRunApiDeps): Date {
  return deps.now?.() ?? new Date();
}

function ctx(caller: Caller) {
  return {
    externalId: caller.externalId,
    projectId: caller.projectId,
    orgId: caller.organizationId,
  };
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/** Whether the session is the caller's own, in the caller's project: pins never cross sessions or projects. */
async function ownsSession(
  fakes: FakeStore,
  sessionId: string,
  caller: { projectId: string; externalId: string },
): Promise<boolean> {
  const owner = await fakes.sessionOwner(sessionId);
  return !!owner && owner.projectId === caller.projectId && owner.ownerUserId === caller.externalId;
}
