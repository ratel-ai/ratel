import { existsSync } from "node:fs";
import { join } from "node:path";
import { isSpanContextValid, SpanStatusCode, trace } from "@opentelemetry/api";
import { type LoadedTwin, loadTwins, messageOf } from "../cli/load.js";
import { buildManifest } from "../manifest.js";
import { runTwin } from "../run.js";
import type { Twin, TwinEventPayload } from "../twin.js";
import type { ChildReply, ChildRequest } from "./child-messages.js";
import type { RunResult, RunStartPayload } from "./runs.js";

// The long-lived child of `ratel dev`. It is the only process that loads user
// code and the project's .env. The parent restarts it on a file change, so each
// generation imports the code fresh. It lives until the parent disconnects.

let envLoaded = false;
let twins: LoadedTwin[] = [];
/** Settles when the last twin load ends. A run that arrives during a load waits for it. */
let loading: Promise<unknown> = Promise.resolve();
/** Live runs by ID. Deleted when the run ends or is canceled. */
const live = new Map<string, AbortController>();

process.on("message", (request: ChildRequest) => {
  switch (request.kind) {
    case "manifest":
      manifest(request)
        .catch((err: unknown): ChildReply => ({ id: request.id, ok: false, error: messageOf(err) }))
        .then(reply);
      return;
    case "run":
      void execute(request.runId, request.start);
      return;
    case "cancel":
      cancel(request.runId, request.reason);
      return;
  }
});
process.on("disconnect", () => process.exit(0));

async function manifest(request: Extract<ChildRequest, { kind: "manifest" }>): Promise<ChildReply> {
  loadEnvOnce(request.root);
  const load = loadTwins(request.root, request.files);
  loading = load.catch(() => {});
  twins = await load;
  return {
    id: request.id,
    ok: true,
    kind: "manifest",
    manifest: buildManifest({ twins, build: request.build, env: process.env }),
  };
}

/** One run. Reports its events and exactly one run.end, unless it was canceled first. */
async function execute(runId: string, start: RunStartPayload): Promise<void> {
  await loading;
  const twin = twins.find((t) => t.twin.id === start.twinId)?.twin;
  if (!twin) {
    end(runId, undefined, {
      status: "error",
      error: { code: "unknown_twin", message: start.twinId },
    });
    return;
  }
  const abort = new AbortController();
  live.set(runId, abort);
  const tracer = trace.getTracer("@ratel-ai/twin");
  await tracer.startActiveSpan(`invoke_workflow ${twin.id}`, async (span) => {
    const spanContext = span.spanContext();
    const traceId = isSpanContextValid(spanContext) ? spanContext.traceId : undefined;
    try {
      const result = await runTwin(twin, {
        input: start.input,
        overrides: start.params,
        context: start.context,
        signal: abort.signal,
        onLog: (message, level) => event(twin, runId, { kind: "log", level, message }),
      });
      end(runId, twin, {
        status: "ok",
        output: result.output,
        overrides: result.overrides,
        ...(traceId ? { traceId } : {}),
      });
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: messageOf(err) });
      end(runId, twin, {
        status: "error",
        error: { code: "run_failed", message: `${twin.id}: run() threw: ${messageOf(err)}` },
        ...(traceId ? { traceId } : {}),
      });
    } finally {
      span.end();
    }
  });
}

function cancel(runId: string, reason: string): void {
  const abort = live.get(runId);
  if (!abort) return;
  abort.abort(new Error(reason));
  // The run ends now. Whatever run() still does after the abort is not reported.
  end(runId, undefined, { status: "canceled" });
}

function event(twin: Twin, runId: string, payload: TwinEventPayload): void {
  if (!live.has(runId)) return;
  reply({ kind: "run.event", runId, payload: redact(twin, payload) });
}

/** Sends the one run.end of a run. Skipped for a run that already ended (a cancel came first). */
function end(runId: string, twin: Twin | undefined, result: RunResult): void {
  if (twin !== undefined && !live.has(runId)) return;
  live.delete(runId);
  reply({ kind: "run.end", runId, result: twin ? redactEnd(twin, result) : result });
}

function redact(twin: Twin, payload: TwinEventPayload): TwinEventPayload {
  if (!twin.redact) return payload;
  try {
    return { ...twin.redact(payload), kind: payload.kind };
  } catch (err) {
    // A failing redact must not leak the original: send a marker instead.
    return { kind: payload.kind, redactError: messageOf(err) };
  }
}

function redactEnd(twin: Twin, result: RunResult): RunResult {
  if (!twin.redact) return result;
  try {
    const { kind: _kind, ...rest } = twin.redact({ kind: "run.end", ...result });
    return { ...rest, status: result.status } as RunResult;
  } catch (err) {
    return {
      status: "error",
      error: { code: "redact_failed", message: `${twin.id}: redact() threw: ${messageOf(err)}` },
      ...(result.traceId ? { traceId: result.traceId } : {}),
    };
  }
}

function reply(message: ChildReply): void {
  process.send?.(message);
}

function loadEnvOnce(root: string): void {
  if (envLoaded) return;
  envLoaded = true;
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}
