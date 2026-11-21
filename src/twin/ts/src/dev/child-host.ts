import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Manifest } from "../manifest.js";
import type { ChildReply, ChildRequest } from "./child-messages.js";
import type {
  RunEventPayload,
  RunResult,
  RunStartPayload,
  ToolAnswerType,
  ToolRequestType,
} from "./runs.js";
import type { PlaygroundTelemetryConfig } from "./tracing.js";

// The parent side of the `ratel dev` child worker: forks it under tsx, asks it
// for the manifest, hands it runs and replaces it on reload. The parent never
// imports user code.

type Pending = (reply: Extract<ChildReply, { id: number }>) => void;

export interface RunHandlers {
  onEvent(payload: RunEventPayload): void;
  onEnd(result: RunResult): void;
  onToolRequest?(
    type: ToolRequestType,
    payload: { readonly callId: string } & Readonly<Record<string, unknown>>,
  ): void;
}

export class ChildHost {
  #child: ChildProcess | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  /** Live runs, with the child that runs each one. */
  readonly #runs = new Map<string, { handlers: RunHandlers; child: ChildProcess }>();
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  /**
   * Loads the twins in a new child and switches to it. The old child keeps
   * serving until the new one loaded: when the load fails, the new child is
   * dropped, the old one stays, and this throws.
   */
  async restart(
    files: readonly string[],
    build: Manifest["build"],
    telemetry?: PlaygroundTelemetryConfig,
  ): Promise<Manifest> {
    const candidate = this.#fork();
    const reply = await this.#ask(candidate, {
      kind: "manifest",
      root: this.#root,
      files,
      build,
      ...(telemetry ? { telemetry } : {}),
    });
    if (!reply.ok) {
      if (candidate.exitCode === null) candidate.kill();
      throw new Error(reply.error);
    }
    const old = this.#child;
    this.#child = candidate;
    if (old) this.#retire(old);
    return reply.manifest;
  }

  /** Starts one run in the child. Exactly one onEnd follows, also if the child dies. */
  run(runId: string, start: RunStartPayload, handlers: RunHandlers): void {
    const child = this.#child;
    if (!child) {
      handlers.onEnd(workerGone("the twin worker is not running"));
      return;
    }
    this.#runs.set(runId, { handlers, child });
    child.send({ kind: "run", runId, start } satisfies ChildRequest);
  }

  /** Hands the controller's answer to the child that runs the run. */
  answer(
    runId: string,
    answerType: ToolAnswerType,
    payload: Readonly<Record<string, unknown>>,
  ): void {
    this.#runs
      .get(runId)
      ?.child.send({ kind: "tool.answer", runId, answerType, payload } satisfies ChildRequest);
  }

  cancel(runId: string, reason: string): void {
    this.#runs.get(runId)?.child.send({ kind: "cancel", runId, reason } satisfies ChildRequest);
  }

  /** Stops every child. Live runs end with worker_exited. */
  stop(): void {
    const children = new Set([this.#child, ...[...this.#runs.values()].map((r) => r.child)]);
    this.#child = undefined;
    for (const child of children) if (child && child.exitCode === null) child.kill();
    this.#failRuns(() => true, "the twin worker was stopped");
  }

  /** A replaced child finishes its live runs, then exits. */
  #retire(child: ChildProcess): void {
    if (![...this.#runs.values()].some((r) => r.child === child) && child.exitCode === null)
      child.kill();
  }

  #fork(): ChildProcess {
    const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const child = fork(fileURLToPath(new URL(`./child.${ext}`, import.meta.url)), [], {
      cwd: this.#root,
      execArgv: ["--import", import.meta.resolve("tsx")],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    child.on("message", (reply: ChildReply) => this.#onReply(reply));
    child.once("exit", (code) => {
      if (this.#child === child) this.#child = undefined;
      this.#failRuns((r) => r.child === child, `the twin worker exited with code ${code}`);
    });
    return child;
  }

  #onReply(reply: ChildReply): void {
    if ("id" in reply) {
      const resolve = this.#pending.get(reply.id);
      this.#pending.delete(reply.id);
      resolve?.(reply);
      return;
    }
    const run = this.#runs.get(reply.runId);
    if (!run) return;
    if (reply.kind === "run.event") {
      run.handlers.onEvent(reply.payload);
      return;
    }
    if (reply.kind === "tool.request") {
      run.handlers.onToolRequest?.(reply.type, reply.payload);
      return;
    }
    this.#runs.delete(reply.runId);
    run.handlers.onEnd(reply.result);
    if (run.child !== this.#child) this.#retire(run.child);
  }

  /** Asks one child. Resolves with an error reply if that child exits before it answers. */
  #ask(
    child: ChildProcess,
    request: Omit<Extract<ChildRequest, { kind: "manifest" }>, "id">,
  ): Promise<Extract<ChildReply, { id: number }>> {
    const id = this.#nextId++;
    return new Promise((resolve) => {
      const onExit = (code: number | null) => {
        this.#pending.delete(id);
        resolve({ id, ok: false, error: `the twin worker exited with code ${code} while loading` });
      };
      child.once("exit", onExit);
      this.#pending.set(id, (reply) => {
        child.off("exit", onExit);
        resolve(reply);
      });
      child.send({ ...request, id } satisfies ChildRequest);
    });
  }

  #failRuns(
    match: (run: { handlers: RunHandlers; child: ChildProcess }) => boolean,
    error: string,
  ): void {
    for (const [runId, run] of [...this.#runs]) {
      if (!match(run)) continue;
      this.#runs.delete(runId);
      run.handlers.onEnd(workerGone(error));
    }
  }
}

function workerGone(message: string): RunResult {
  return { status: "error", error: { code: "worker_exited", message } };
}
