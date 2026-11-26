import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { getLogger } from "@/lib/platform/logger";
import {
  type ExecRequest,
  type ExecResult,
  ProviderAtCapacity,
  ProviderRateLimited,
  ProviderRefused,
  ProviderUnavailable,
  type SandboxProvider,
  type StartVmRequest,
  VM_START_TIMEOUT_MS,
  type VmInfo,
  type VmState,
  type WriteFileRequest,
} from "../ports/sandbox-provider";

/**
 * {@link SandboxProvider} on the v1 HTTP API of boat.dev, with plain `fetch`. Each VM starts with
 * no secret of the account (`noEnv`). No error message names the service, and no message or log
 * holds the API key or a value of a file. Each VM carries the label of the deployment, and
 * `listVms` lists only the VMs with it: other deployments can share the account.
 */
export type BoatProviderOptions = {
  apiKey: string;
  /** The value of the `ratel-deployment` label (`provider-from-env.ts`). */
  deploymentId: string;
  /** `https://boat.dev/api/v1` by default. */
  baseUrl?: string;
  /** The machine size, `small` by default. */
  vmType?: string;
  fetch?: typeof fetch;
  /** The wait between two polls. */
  pollMs?: number;
  /** The limit of the create and the ready wait of a start. The Docker wait comes after it. */
  readyTimeoutMs?: number;
  /** The limit of a snapshot save. */
  snapshotTimeoutMs?: number;
  /** A larger file goes to an upload URL. The API takes up to 5 MiB inline. */
  inlineMaxBytes?: number;
};

export const DEFAULT_BOAT_API_URL = "https://boat.dev/api/v1";
export const DEFAULT_BOAT_VM_TYPE = "small";

const READY = new Set(["ready", "idle", "running"]);
const STARTING = new Set(["init", "provisioning", "provisioned", "cloning"]);
const STOPPED = new Set(["archiving", "archived", "error"]);
const AT_CAPACITY = new Set(["limit_reached", "member_limit_reached"]);
/** A command sent while the VM still starts. Sending it again is safe. */
const NOT_READY_YET = new Set(["boat_starting", "sandbox_starting"]);
const DEPLOYMENT_LABEL = "ratel-deployment";
const SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const INLINE_MAX_BYTES = 5 * 1024 * 1024;
/** Fetch waits at most 300 s for the headers of an answer: a longer command runs detached. */
const SYNC_EXEC_MAX_S = 240;
/** The service ends a command after this time: a longer command runs as a job of the VM. */
const MAX_EXEC_S = 600;
/** One wait for the end of a job. It is a short command. */
const JOB_WAIT_S = 200;
/** The time that a job needs beyond its own timeout: the kill and the last wait. */
const JOB_SLACK_S = 60;
/** `timeout` ends with 124 when the time is over. */
const JOB_TIMED_OUT = "124";
const CREATE_ATTEMPTS = 3;
const EXEC_ATTEMPTS = 4;
const UPLOAD_URL_TTL_S = 3600;
/** Docker comes a few seconds after the VM is ready. */
const DOCKER_WAIT = {
  command: "for i in $(seq 1 90); do docker info >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1",
  timeoutS: 120,
};
/** The Docker wait ends the start, so the rest of the start has the time before it. */
const READY_TIMEOUT_MS = VM_START_TIMEOUT_MS - DOCKER_WAIT.timeoutS * 1000;

const logger = getLogger("sandboxes/provider");

export function createBoatProvider(options: BoatProviderOptions): SandboxProvider {
  const api = createApi(options);
  const pollMs = options.pollMs ?? 2000;
  const inlineMax = options.inlineMaxBytes ?? INLINE_MAX_BYTES;

  const provider: SandboxProvider = {
    async startVm(request) {
      const deadline = Date.now() + (options.readyTimeoutMs ?? READY_TIMEOUT_MS);
      const created = await api.call<{ sandbox: { id: string } }>("POST", "/sandboxes", {
        json: createBody(request, options.vmType ?? DEFAULT_BOAT_VM_TYPE, options.deploymentId),
        headers: { "idempotency-key": randomUUID() },
        attempts: CREATE_ATTEMPTS,
        retryWhen: (status, code) =>
          status === 0 || status >= 500 || code === "idempotency_in_progress",
      });
      const vmRef = created.sandbox.id;
      try {
        await waitReady(vmRef, deadline);
        const docker = await provider.exec(vmRef, DOCKER_WAIT);
        if (docker.exitCode !== 0)
          throw new ProviderUnavailable("Docker did not start in the sandbox.");
        return { vmRef };
      } catch (error) {
        await provider.deleteVm(vmRef).catch((failure: unknown) => {
          // The TTL of the VM still ends it.
          logger.warn({ vm_ref: vmRef, error_type: errorType(failure) }, "vm not deleted");
        });
        throw error;
      }
    },

    async exec(vmRef, request) {
      if (request.stdin === undefined) return run(vmRef, request);
      const path = `/tmp/ratel-stdin-${randomUUID()}`;
      const body = Buffer.from(request.stdin);
      await provider.writeFile(vmRef, { path, body, size: body.length });
      try {
        return await run(vmRef, { ...request, command: `( ${request.command} ) < '${path}'` });
      } finally {
        await api
          .call("DELETE", `/sandboxes/${enc(vmRef)}/files`, {
            query: [["path", path]],
            missingOk: true,
          })
          .catch((failure: unknown) => {
            logger.warn(
              { vm_ref: vmRef, error_type: errorType(failure) },
              "stdin file not deleted",
            );
          });
      }
    },

    async writeFile(vmRef, request) {
      if (request.size <= inlineMax) {
        const content = Buffer.from(await bytesOf(request.body)).toString("base64");
        await api.call("PUT", `/sandboxes/${enc(vmRef)}/files`, {
          json: { path: request.path, content, encoding: "base64" },
        });
        return;
      }
      const { url } = await api.call<{ url: string }>(
        "POST",
        `/sandboxes/${enc(vmRef)}/files/upload-url`,
        {
          json: { path: request.path, ttlSeconds: UPLOAD_URL_TTL_S },
        },
      );
      await api.upload(url, request);
    },

    async saveSnapshot(vmRef, name) {
      if (!SNAPSHOT_NAME.test(name)) throw new Error(`The snapshot name ${name} is not valid.`);
      await api.call("POST", "/saved-snapshots", { json: { sandboxId: vmRef, name } });
      const deadline = Date.now() + (options.snapshotTimeoutMs ?? 30 * 60_000);
      for (;;) {
        const { snapshot } = await api.call<{ snapshot: { status: string } }>(
          "GET",
          `/saved-snapshots/${enc(name)}`,
        );
        if (snapshot.status === "ready") return { snapshotRef: name };
        if (snapshot.status !== "saving")
          throw new ProviderUnavailable("The snapshot was not saved.");
        if (Date.now() > deadline)
          throw new ProviderUnavailable("The snapshot took too long to save.");
        await sleep(pollMs);
      }
    },

    async deleteVm(vmRef) {
      await api.call("DELETE", `/sandboxes/${enc(vmRef)}`, {
        headers: { "x-ascii-confirm-delete": vmRef },
        missingOk: true,
      });
    },

    async deleteSnapshot(snapshotRef) {
      await api.call("DELETE", `/saved-snapshots/${enc(snapshotRef)}`, { missingOk: true });
    },

    async vmStatus(vmRef) {
      const found = await api.call<{ sandbox: { state: string } } | null>(
        "GET",
        `/sandboxes/${enc(vmRef)}`,
        { missingOk: true },
      );
      return { state: found ? stateOf(found.sandbox.state) : "gone" };
    },

    async listVms(labels) {
      const vms: VmInfo[] = [];
      let cursor: string | null = null;
      do {
        const own = { ...labels, [DEPLOYMENT_LABEL]: options.deploymentId };
        const query: [string, string][] = Object.entries(own).map(([key, value]) => [
          "label",
          `${key}=${value}`,
        ]);
        query.push(["limit", "200"]);
        if (cursor) query.push(["cursor", cursor]);
        const page: ListPage = await api.call<ListPage>("GET", "/sandboxes", { query });
        for (const sandbox of page.sandboxes) {
          vms.push({
            vmRef: sandbox.id,
            labels: sandbox.labels ?? {},
            createdAt: new Date(sandbox.createdAt),
          });
        }
        cursor = page.pageInfo?.hasMore ? (page.pageInfo.nextCursor ?? null) : null;
      } while (cursor);
      return vms;
    },
  };

  async function waitReady(vmRef: string, deadline: number): Promise<void> {
    for (;;) {
      const { sandbox } = await api.call<{ sandbox: { state: string } }>(
        "GET",
        `/sandboxes/${enc(vmRef)}`,
      );
      if (READY.has(sandbox.state)) return;
      if (!STARTING.has(sandbox.state)) throw new ProviderUnavailable("The sandbox did not start.");
      if (Date.now() > deadline)
        throw new ProviderUnavailable("The sandbox took too long to start.");
      await sleep(pollMs);
    }
  }

  async function run(vmRef: string, request: ExecRequest): Promise<ExecResult> {
    const timeoutS = Math.max(Math.ceil(request.timeoutS), 1);
    if (timeoutS > MAX_EXEC_S) return runJob(vmRef, request.command, timeoutS);
    const path = `/sandboxes/${enc(vmRef)}/commands`;
    const send = {
      attempts: EXEC_ATTEMPTS,
      retryWhen: (_: number, code: string) => NOT_READY_YET.has(code),
    };
    if (timeoutS <= SYNC_EXEC_MAX_S) {
      const done = await api.call<CommandAnswer>("POST", path, {
        json: { command: request.command, timeoutSeconds: timeoutS },
        ...send,
      });
      return resultOf(done);
    }
    const { processId } = await api.call<{ processId: number }>("POST", path, {
      json: { command: request.command, timeoutSeconds: timeoutS, detached: true },
      ...send,
    });
    const deadline = Date.now() + timeoutS * 1000;
    for (;;) {
      const status = await api.call<CommandAnswer & { running: boolean }>(
        "GET",
        `${path}/${processId}`,
      );
      if (!status.running) return resultOf(status);
      if (Date.now() > deadline) {
        await api.call("DELETE", `${path}/${processId}`, { missingOk: true });
        return {
          exitCode: null,
          stdout: status.stdout ?? "",
          stderr: status.stderr ?? "",
          timedOut: true,
        };
      }
      await sleep(pollMs);
    }
  }

  /**
   * Runs a command longer than the service allows as a job of the VM: a short command starts it
   * in its own session, and short commands wait for its exit code. The command goes in a file, so
   * no quoting can change it. The job and its files go at the end, also after a failure.
   */
  async function runJob(vmRef: string, command: string, timeoutS: number): Promise<ExecResult> {
    const job = jobFiles(`/tmp/ratel-job-${randomUUID()}`);
    const script = Buffer.from(command);
    const short = (line: string, seconds = 30) => run(vmRef, { command: line, timeoutS: seconds });
    try {
      await provider.writeFile(vmRef, { path: job.script, body: script, size: script.length });
      const started = await short(
        // The exit code goes to its file in one move, so a wait never reads half of it.
        `setsid nohup sh -c 'timeout -k 10 ${timeoutS} sh ${job.script} > ${job.out} 2> ${job.err}; echo $? > ${job.part} && mv ${job.part} ${job.exit}' > /dev/null 2>&1 < /dev/null &`,
      );
      if (started.exitCode !== 0) throw new ProviderUnavailable("The command did not start.");
      const deadline = Date.now() + (timeoutS + JOB_SLACK_S) * 1000;
      for (;;) {
        const waited = await short(
          `for i in $(seq 1 ${JOB_WAIT_S}); do [ -f ${job.exit} ] && cat ${job.exit} && exit 0; sleep 1; done; exit 1`,
          JOB_WAIT_S + 30,
        );
        const code = waited.exitCode === 0 ? /^\d+$/.exec(waited.stdout.trim())?.[0] : undefined;
        if (code !== undefined || Date.now() > deadline) {
          const stdout = (await short(`cat ${job.out}`)).stdout;
          const stderr = (await short(`cat ${job.err}`)).stdout;
          if (code === undefined || code === JOB_TIMED_OUT) {
            return { exitCode: null, stdout, stderr, timedOut: true };
          }
          return { exitCode: Number(code), stdout, stderr, timedOut: false };
        }
      }
    } finally {
      await short(`pkill -KILL -f ${job.script}; rm -f ${job.all}; true`).catch(
        (failure: unknown) => {
          // The TTL of the VM still ends the job.
          logger.warn({ vm_ref: vmRef, error_type: errorType(failure) }, "job not removed");
        },
      );
    }
  }

  return provider;
}

type CommandAnswer = {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
};
type ListPage = {
  sandboxes: { id: string; labels?: Record<string, string>; createdAt: string }[];
  pageInfo?: { nextCursor: string | null; hasMore: boolean };
};
type CallOptions = {
  json?: unknown;
  headers?: Record<string, string>;
  query?: [string, string][];
  /** A 404 answers null. */
  missingOk?: boolean;
  attempts?: number;
  /** Whether a failed call goes again. Status 0 is a network error. */
  retryWhen?: (status: number, code: string) => boolean;
};

function createBody(request: StartVmRequest, type: string, deploymentId: string) {
  const { outbound, inbound } = request.network;
  return {
    type,
    ttlSeconds: request.ttlS,
    labels: {
      ...request.labels,
      "ratel-project": request.projectId,
      "ratel-purpose": request.purpose,
      [DEPLOYMENT_LABEL]: deploymentId,
    },
    // No secret of the account goes into a VM.
    noEnv: true,
    snapshots: request.keepSnapshots,
    network: {
      mode: outbound.mode,
      ...(outbound.mode === "allow" ? { allow: [...outbound.allow] } : {}),
      inbound: inbound === "open" ? "open" : "boat-only",
    },
    ...(request.fromSnapshot ? { from: request.fromSnapshot } : {}),
  };
}

function jobFiles(prefix: string) {
  const files = {
    script: `${prefix}.sh`,
    out: `${prefix}.out`,
    err: `${prefix}.err`,
    exit: `${prefix}.exit`,
    part: `${prefix}.exit.part`,
  };
  return { ...files, all: Object.values(files).join(" ") };
}

function stateOf(state: string): VmState {
  if (READY.has(state)) return "running";
  if (STARTING.has(state)) return "starting";
  if (STOPPED.has(state)) return "stopped";
  return "gone";
}

function resultOf(answer: CommandAnswer): ExecResult {
  return {
    exitCode: answer.exitCode ?? null,
    stdout: answer.stdout ?? "",
    stderr: answer.stderr ?? "",
    timedOut: answer.timedOut ?? false,
  };
}

function createApi(options: BoatProviderOptions) {
  const base = (options.baseUrl ?? DEFAULT_BOAT_API_URL).replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const pollMs = options.pollMs ?? 2000;

  async function once(method: string, path: string, call: CallOptions) {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of call.query ?? []) url.searchParams.append(key, value);
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.apiKey}`,
      accept: "application/json",
      ...call.headers,
    };
    if (call.json !== undefined) headers["content-type"] = "application/json";
    const body = call.json === undefined ? undefined : JSON.stringify(call.json);
    try {
      return await doFetch(url, { method, headers, body });
    } catch (error) {
      throw new ProviderUnavailable("The sandbox service did not answer.", { cause: error });
    }
  }

  return {
    async call<T = unknown>(method: string, path: string, call: CallOptions = {}): Promise<T> {
      const attempts = call.attempts ?? 1;
      for (let attempt = 1; ; attempt++) {
        let failure: Error;
        let status = 0;
        let code = "";
        try {
          const response = await once(method, path, call);
          if (response.ok) return (await jsonOf(response)) as T;
          if (response.status === 404 && call.missingOk) return null as T;
          const body = await jsonOf(response);
          status = response.status;
          code = codeOf(body);
          failure = errorOf(response, body);
        } catch (error) {
          if (!(error instanceof ProviderUnavailable)) throw error;
          failure = error;
        }
        if (attempt >= attempts || !call.retryWhen?.(status, code)) throw failure;
        await sleep(pollMs);
      }
    },

    /** PUTs a body to a signed URL. The URL holds its own permission: no API key goes with it. */
    async upload(url: string, request: WriteFileRequest): Promise<void> {
      const body =
        request.body instanceof Uint8Array ? request.body : (request.body as unknown as BodyInit);
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(request.size),
          },
          body,
          duplex: "half",
        } as RequestInit);
      } catch (error) {
        throw new ProviderUnavailable("The sandbox service did not take the file.", {
          cause: error,
        });
      }
      if (!response.ok) throw errorOf(response, await jsonOf(response));
      await response.body?.cancel();
    },
  };
}

/** The typed error of a failed answer. No text of the service goes in the message. */
function errorOf(response: Response, body: unknown): Error {
  const { status } = response;
  const code = codeOf(body);
  const detail = safeCode(code) ? `status ${status}, ${code}` : `status ${status}`;
  if (AT_CAPACITY.has(code)) return new ProviderAtCapacity();
  if (status === 429) {
    return new ProviderRateLimited(
      `The sandbox service limits the calls or the starts (${detail}). Try again later.`,
      retryAfterOf(response, body),
    );
  }
  if (status >= 500) return new ProviderUnavailable(`The sandbox service failed (${detail}).`);
  if (status === 401)
    return new ProviderRefused(`The sandbox service refused the API key (${detail}).`, status);
  if (status === 402) {
    return new ProviderRefused(`The sandbox service account needs billing (${detail}).`, status);
  }
  if (status === 403) {
    return new ProviderRefused(
      `The sandbox service refused a permission of the API key (${detail}).`,
      status,
    );
  }
  return new ProviderRefused(`The sandbox service refused the call (${detail}).`, status);
}

function retryAfterOf(response: Response, body: unknown): number | null {
  const header = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header;
  const fields = (body ?? {}) as { retryAfterSeconds?: unknown; retryAfter?: unknown };
  const value = Number(fields.retryAfterSeconds ?? fields.retryAfter);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function codeOf(body: unknown): string {
  const { code, error } = (body ?? {}) as { code?: unknown; error?: { code?: unknown } };
  const found = code ?? error?.code;
  return typeof found === "string" ? found : "";
}

/** A code that is safe to show: a plain word that does not name the service. */
function safeCode(code: string): boolean {
  return /^[a-z0-9_]{1,64}$/.test(code) && !/boat|ascii/.test(code);
}

async function jsonOf(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function bytesOf(body: WriteFileRequest["body"]): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const parts: Uint8Array[] = [];
  for await (const part of body) parts.push(part);
  return Buffer.concat(parts);
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
