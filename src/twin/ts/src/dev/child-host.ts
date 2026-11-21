import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Manifest } from "../manifest.js";
import type { ChildReply, ChildRequest } from "./child-messages.js";

// The parent side of the `ratel dev` child worker: forks it under tsx, asks it
// questions over IPC and replaces it on reload. The parent never imports user code.

type Pending = (reply: ChildReply) => void;

export class ChildHost {
  #child: ChildProcess | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
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

  stop(): void {
    const child = this.#child;
    this.#child = undefined;
    if (child && child.exitCode === null) child.kill();
    this.#failPending("the twin worker was restarted");
  }

  #fork(): ChildProcess {
    const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const child = fork(fileURLToPath(new URL(`./child.${ext}`, import.meta.url)), [], {
      cwd: this.#root,
      execArgv: ["--import", import.meta.resolve("tsx")],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    child.on("message", (reply: ChildReply) => {
      const resolve = this.#pending.get(reply.id);
      this.#pending.delete(reply.id);
      resolve?.(reply);
    });
    child.once("exit", (code) => {
      if (this.#child === child) {
        this.#child = undefined;
        this.#failPending(`the twin worker exited with code ${code}`);
      }
    });
    return child;
  }

  #ask(request: Omit<ChildRequest, "id">): Promise<ChildReply> {
    const child = this.#child;
    if (!child) return Promise.reject(new Error("the twin worker is not running"));
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      child.send({ ...request, id } as ChildRequest);
    });
  }

  #failPending(error: string): void {
    for (const [id, resolve] of this.#pending) resolve({ id, ok: false, error });
    this.#pending.clear();
  }
}
