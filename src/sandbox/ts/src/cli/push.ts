import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Manifest } from "../manifest.js";
import { CliError } from "./args.js";
import type { Bundle } from "./bundle.js";

// The client of the push contract (protocol/sandbox/v1/schema/push): per
// sandbox, (1) create a version, (2) PUT the bundle to its upload URL, (3)
// finalize it with the bundle's SHA-256. The project key goes to the Ratel API
// only, never to the upload URL.

export const VERSIONS_PATH = "/api/v1/sandboxes/versions";

export interface PushOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly manifest: Manifest;
  readonly sandboxId: string;
  readonly bundle: Bundle;
  readonly fetch?: typeof fetch;
  /** Called while the bundle uploads, with the bytes sent so far. */
  readonly onUpload?: (sent: number, total: number) => void;
}

export interface PushResult {
  readonly sandboxId: string;
  readonly versionId: string;
  readonly status: "building" | "ready" | "failed";
  readonly playgroundUrl: string;
  /** False when the server already had a bundle with this SHA-256. */
  readonly uploaded: boolean;
  readonly error?: string;
}

/** Pushes one sandbox: create, upload, finalize. Throws a CliError with the step that failed. */
export async function pushSandbox(options: PushOptions): Promise<PushResult> {
  const { bundle, sandboxId } = options;
  const created = await callApi(options, VERSIONS_PATH, {
    sandboxId,
    manifest: {
      ...options.manifest,
      sandboxes: options.manifest.sandboxes.filter((s) => s.id === sandboxId),
    },
    bundle: { sha256: bundle.sha256, bytes: bundle.data.length, files: bundle.files.length },
  });
  const versionId = created.versionId;
  if (typeof versionId !== "string" || versionId === "")
    throw new CliError(`${sandboxId}: the server answered the new version without a versionId`);
  const uploadUrl = typeof created.uploadUrl === "string" ? created.uploadUrl : undefined;
  if (uploadUrl) {
    await upload(uploadUrl, stringRecord(created.uploadHeaders), bundle.data, (sent) =>
      options.onUpload?.(sent, bundle.data.length),
    ).catch((err: unknown) => {
      throw new CliError(`${sandboxId}: the bundle upload failed: ${messageOf(err)}`);
    });
  }
  const finalized = await callApi(
    options,
    `${VERSIONS_PATH}/${encodeURIComponent(versionId)}/finalize`,
    { sha256: bundle.sha256 },
  );
  const status = finalized.status;
  if (status !== "building" && status !== "ready" && status !== "failed")
    throw new CliError(`${sandboxId}: the server answered finalize with status ${String(status)}`);
  if (typeof finalized.playgroundUrl !== "string")
    throw new CliError(`${sandboxId}: the server answered finalize without a playgroundUrl`);
  return {
    sandboxId,
    versionId,
    status,
    playgroundUrl: finalized.playgroundUrl,
    uploaded: uploadUrl !== undefined,
    ...(typeof finalized.error === "string" ? { error: finalized.error } : {}),
  };
}

/** POST a JSON body to the Ratel API with the project key. Resolves with the JSON answer. */
async function callApi(
  options: PushOptions,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const doFetch = options.fetch ?? fetch;
  const url = new URL(path, options.baseUrl);
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new CliError(`cannot reach ${url.origin}: ${messageOf(err)}`);
  }
  const answer = (await response.json().catch(() => undefined)) as
    | Record<string, unknown>
    | undefined;
  if (!response.ok) throw apiFailure(response.status, url, answer?.error);
  if (typeof answer !== "object" || answer === null)
    throw new CliError(`${url.origin} answered ${url.pathname} without a JSON object`);
  return answer;
}

function apiFailure(status: number, url: URL, error: unknown): CliError {
  const why = typeof error === "string" && error !== "" ? `: ${error}` : "";
  if (status === 401 || status === 403)
    return new CliError(`${url.origin} refused the project key (HTTP ${status})${why}`);
  if (status === 404)
    return new CliError(
      `${url.origin} has no sandbox push for this project (HTTP 404): sandboxes may be off${why}`,
    );
  if (status === 413) return new CliError(`${url.origin} refused the bundle as too large${why}`);
  return new CliError(`${url.origin} answered ${url.pathname} with HTTP ${status}${why}`);
}

/** PUT the bundle in chunks with a content length, so a presigned URL accepts it and progress shows. */
function upload(
  url: string,
  headers: Record<string, string>,
  data: Buffer,
  onProgress: (sent: number) => void,
): Promise<void> {
  const target = new URL(url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      target,
      { method: "PUT", headers: { ...headers, "content-length": String(data.length) } },
      (res) => {
        res.resume();
        res.on("end", () => {
          const code = res.statusCode ?? 0;
          if (code >= 200 && code < 300) resolve();
          else reject(new Error(`${target.origin} answered HTTP ${code}`));
        });
      },
    );
    req.on("error", reject);
    const CHUNK = 256 * 1024;
    let sent = 0;
    const writeNext = (): void => {
      while (sent < data.length) {
        const chunk = data.subarray(sent, sent + CHUNK);
        sent += chunk.length;
        onProgress(sent);
        if (!req.write(chunk)) {
          req.once("drain", writeNext);
          return;
        }
      }
      req.end();
    };
    writeNext();
  });
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
