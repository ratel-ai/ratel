import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Manifest } from "../manifest.js";
import type { ChildReply, ChildRequest } from "./child-messages.js";
import type { RunEventPayload, RunResult, RunStartPayload } from "./runs.js";

// The parent side of the `ratel dev` child worker: forks it under tsx, asks it
// for the manifest, hands it runs and replaces it on reload. The parent never
// imports user code.

type Pending = (reply: Extract<ChildReply, { id: number }>) => void;

export interface RunHandlers {
  onEvent(payload: RunEventPayload): void;
  onEnd(result: RunResult): void;
}

export class ChildHost {
  #child: ChildProcess | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  readonly #runs = new Map<string, RunHandlers>();
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  /** Starts a fresh child (stopping the old one) and loads the manifest from it. */
  async restart(files: readonly string[], build: Manifest["build"]): Promise<Manifest> {
    this.stop();
    this.#child = this.#fork();
    const reply = await this.#ask({ kind: "manifest", root: this.#root, files, build });
    if (!reply.ok) throw new Error(reply.error);
    return reply.manifest;
  }

  /** Starts one run in the child. Exactly one onEnd follows, also if the child dies. */
  run(runId: string, start: RunStartPayload, handlers: RunHandlers): void {
    const child = this.#child;
    if (!child) {
      handlers.onEnd(workerGone("the twin worker is not running"));
      return;
    }
    this.#runs.set(runId, handlers);
    child.send({ kind: "run", runId, start } satisfies ChildRequest);
  }

  cancel(runId: string, reason: string): void {
    if (this.#runs.has(runId))
      this.#child?.send({ kind: "cancel", runId, reason } satisfies ChildRequest);
  }

  stop(): void {
    const child = this.#child;
    this.#child = undefined;
    if (child && child.exitCode === null) child.kill();
    this.#failAll("the twin worker was restarted");
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
      if (this.#child !== child) return;
      this.#child = undefined;
      this.#failAll(`the twin worker exited with code ${code}`);
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
    const handlers = this.#runs.get(reply.runId);
    if (!handlers) return;
    if (reply.kind === "run.event") {
      handlers.onEvent(reply.payload);
      return;
    }
    this.#runs.delete(reply.runId);
    handlers.onEnd(reply.result);
  }

  #ask(
    request: Omit<Extract<ChildRequest, { kind: "manifest" }>, "id">,
  ): Promise<Extract<ChildReply, { id: number }>> {
    const child = this.#child;
    if (!child) return Promise.reject(new Error("the twin worker is not running"));
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      child.send({ ...request, id } satisfies ChildRequest);
    });
  }

  #failAll(error: string): void {
    for (const [id, resolve] of this.#pending) resolve({ id, ok: false, error });
    this.#pending.clear();
    const runs = [...this.#runs.values()];
    this.#runs.clear();
    for (const handlers of runs) handlers.onEnd(workerGone(error));
  }
}

function workerGone(message: string): RunResult {
  return { status: "error", error: { code: "worker_exited", message } };
}
