import { existsSync } from "node:fs";
import { join } from "node:path";
import { trace } from "@opentelemetry/api";
import { type LoadedTwin, loadTwins, messageOf } from "../cli/load.js";
import { buildManifest, SDK_NAME, SDK_VERSION } from "../manifest.js";
import { prepareTools } from "../tools.js";
import type { Twin, TwinEventPayload } from "../twin.js";
import type { ChildReply, ChildRequest } from "./child-messages.js";
import { executeRun } from "./execute.js";
import type { RunResult, RunStartPayload, ToolAnswerType } from "./runs.js";
import { IpcToolChannel } from "./tool-channel.js";
import {
  attachPlaygroundExport,
  type PlaygroundExport,
  type PlaygroundTelemetryConfig,
} from "./tracing.js";

// The long-lived child of `ratel dev`. It is the only process that loads user
// code and the project's .env. The parent restarts it on a file change, so each
// generation imports the code fresh. It lives until the parent disconnects.

let envLoaded = false;
let twins: LoadedTwin[] = [];
/** Settles when the last twin load ends. A run that arrives during a load waits for it. */
let loading: Promise<unknown> = Promise.resolve();
/** Live runs by ID. Deleted when the run ends or is canceled. */
const live = new Map<string, AbortController>();
/** The tool channel of each live run: its fake and confirm calls wait here for the controller. */
const channels = new Map<string, IpcToolChannel>();
let telemetry: PlaygroundTelemetryConfig | undefined;
/** Attached before the first run, after the project's code had the chance to set up its provider. */
let exporter: PlaygroundExport | undefined;

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
    case "tool.answer":
      channels.get(request.runId)?.answer(request.answerType as ToolAnswerType, request.payload);
      return;
  }
});
process.on("disconnect", () => {
  void (exporter?.flush() ?? Promise.resolve()).finally(() => process.exit(0));
});

async function manifest(request: Extract<ChildRequest, { kind: "manifest" }>): Promise<ChildReply> {
  loadEnvOnce(request.root);
  telemetry = request.telemetry;
  const load = loadTwins(request.root, request.files);
  loading = load.catch(() => {});
  twins = await load;
  await prepareTools(twins.flatMap(({ twin }) => Object.values(twin.params)));
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
  const channel = new IpcToolChannel((type, payload) =>
    reply({ kind: "tool.request", runId, type, payload }),
  );
  channels.set(runId, channel);
  const playground = attachOnce();
  const result = await executeRun(twin, {
    runId,
    start,
    tracer: trace.getTracer(SDK_NAME, SDK_VERSION),
    signal: abort.signal,
    onEvent: (payload) => event(twin, runId, payload),
    onTrace: (traceId) => playground?.track(traceId),
    toolChannel: channel,
  });
  end(runId, twin, result);
  await playground?.flush().catch((err: unknown) => {
    process.stderr.write(`ratel dev: trace export failed: ${messageOf(err)}\n`);
  });
}

function attachOnce(): PlaygroundExport | undefined {
  if (exporter || !telemetry) return exporter;
  exporter = attachPlaygroundExport(telemetry);
  if (exporter.mode === "unsupported") {
    process.stderr.write(
      "ratel dev: cannot add the Ratel exporter to this project's tracer provider; playground traces are not sent\n",
    );
  }
  return exporter;
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
  channels.get(runId)?.close(new Error("the run ended"));
  channels.delete(runId);
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
