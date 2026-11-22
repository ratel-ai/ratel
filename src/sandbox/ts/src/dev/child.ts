import { existsSync } from "node:fs";
import { join } from "node:path";
import { trace } from "@opentelemetry/api";
import { withSdkParams } from "../auto-params.js";
import type { CatalogRead } from "../catalog.js";
import { type LoadedSandbox, loadSandboxes, messageOf } from "../cli/load.js";
import { buildManifest, SDK_NAME, SDK_VERSION } from "../manifest.js";
import type { Sandbox, TwinEventPayload } from "../sandbox.js";
import { prepareTools } from "../tools.js";
import type { ChildReply, ChildRequest } from "./child-messages.js";
import { executeRun } from "./execute.js";
import type { RunResult, RunStartPayload, ToolAnswerType } from "./runs.js";
import { IpcToolChannel } from "./tool-channel.js";
import {
  attachPlaygroundExport,
  type PlaygroundExport,
  type PlaygroundTelemetryConfig,
} from "./tracing.js";

// The long-lived child of `ratel sandbox dev`. It is the only process that loads user
// code and the project's .env. The parent restarts it on a file change, so each
// generation imports the code fresh. It lives until the parent disconnects.

let envLoaded = false;
let sandboxes: LoadedSandbox[] = [];
/** The project root of the loaded sandboxes: their files are relative to it. */
let projectRoot = process.cwd();
/** The build of the last manifest request: a manifest the child sends on its own keeps it. */
let lastBuild: Extract<ChildRequest, { kind: "manifest" }>["build"];
/** Settles when the last sandbox load ends. A run that arrives during a load waits for it. */
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
  projectRoot = request.root;
  lastBuild = request.build;
  const load = loadSandboxes(request.root, request.files);
  loading = load.catch(() => {});
  sandboxes = await load;
  await prepareTools(sandboxes.flatMap(({ sandbox }) => Object.values(sandbox.params)));
  return {
    id: request.id,
    ok: true,
    kind: "manifest",
    manifest: currentManifest(),
  };
}

function currentManifest() {
  return buildManifest({ sandboxes, build: lastBuild, env: process.env, root: projectRoot });
}

/**
 * A run can read a prompt or model that loading the sandbox file did not reach (a
 * branch of run()). It becomes an sdk param now, and the controller gets the new manifest.
 */
function growManifest(id: string, reads: readonly CatalogRead[]): void {
  const at = sandboxes.findIndex((t) => t.sandbox.id === id);
  const current = sandboxes[at];
  if (!current) return;
  const grown = withSdkParams(current.sandbox, { reads, tools: [], skills: [] });
  if (grown === current.sandbox) return;
  sandboxes = sandboxes.map((t, i) => (i === at ? { ...current, sandbox: grown } : t));
  reply({ kind: "manifest.grew", manifest: currentManifest() });
}

/** One run. Reports its events and exactly one run.end, unless it was canceled first. */
async function execute(runId: string, start: RunStartPayload): Promise<void> {
  await loading;
  const loaded = sandboxes.find((t) => t.sandbox.id === start.sandboxId);
  const sandbox = loaded?.sandbox;
  if (!sandbox) {
    end(runId, undefined, {
      status: "error",
      error: { code: "unknown_sandbox", message: start.sandboxId },
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
  let reads: readonly CatalogRead[] = [];
  const result = await executeRun(sandbox, {
    onCatalogReads: (r) => {
      reads = r;
    },
    runId,
    start,
    tracer: trace.getTracer(SDK_NAME, SDK_VERSION),
    signal: abort.signal,
    onEvent: (payload) => event(sandbox, runId, payload),
    onTrace: (traceId) => playground?.track(traceId),
    toolChannel: channel,
    ...(loaded ? { sandboxFile: join(projectRoot, loaded.file) } : {}),
  });
  end(runId, sandbox, result);
  growManifest(sandbox.id, reads);
  await playground?.flush().catch((err: unknown) => {
    process.stderr.write(`ratel sandbox dev: trace export failed: ${messageOf(err)}\n`);
  });
}

function attachOnce(): PlaygroundExport | undefined {
  if (exporter || !telemetry) return exporter;
  exporter = attachPlaygroundExport(telemetry);
  if (exporter.mode === "unsupported") {
    process.stderr.write(
      "ratel sandbox dev: cannot add the Ratel exporter to this project's tracer provider; playground traces are not sent\n",
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

function event(sandbox: Sandbox, runId: string, payload: TwinEventPayload): void {
  if (!live.has(runId)) return;
  reply({ kind: "run.event", runId, payload: redact(sandbox, payload) });
}

/** Sends the one run.end of a run. Skipped for a run that already ended (a cancel came first). */
function end(runId: string, sandbox: Sandbox | undefined, result: RunResult): void {
  if (sandbox !== undefined && !live.has(runId)) return;
  live.delete(runId);
  channels.get(runId)?.close(new Error("the run ended"));
  channels.delete(runId);
  reply({ kind: "run.end", runId, result: sandbox ? redactEnd(sandbox, result) : result });
}

function redact(sandbox: Sandbox, payload: TwinEventPayload): TwinEventPayload {
  if (!sandbox.redact) return payload;
  try {
    return { ...sandbox.redact(payload), kind: payload.kind };
  } catch (err) {
    // A failing redact must not leak the original: send a marker instead.
    return { kind: payload.kind, redactError: messageOf(err) };
  }
}

function redactEnd(sandbox: Sandbox, result: RunResult): RunResult {
  if (!sandbox.redact) return result;
  try {
    const { kind: _kind, ...rest } = sandbox.redact({ kind: "run.end", ...result });
    return { ...rest, status: result.status } as RunResult;
  } catch (err) {
    return {
      status: "error",
      error: { code: "redact_failed", message: `${sandbox.id}: redact() threw: ${messageOf(err)}` },
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
