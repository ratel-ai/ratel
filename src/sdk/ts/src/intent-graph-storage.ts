import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { IntentGraph } from "./index.js";
import { resolveS3Endpoint, signS3Request } from "./sigv4.js";

/**
 * Host-owned persistence for an {@link IntentGraph} (ADR-0025). Core stays
 * bytes-in/bytes-out (ADR-0014) — these are thin adapters over
 * `IntentGraph.toJson()`/`fromJson()`/`rev` that live entirely in the SDK.
 *
 * Both implementations use `rev` for two things: **save-when-changed** (skip
 * the write if `rev` hasn't moved since the last save) and **stale-base
 * detection** (raise {@link StaleIntentGraphError} instead of clobbering a
 * concurrent writer — single-writer model, detect don't merge).
 */
export interface ExperimentalIntentGraphStorage {
  /** Load the stored graph, or `null` if nothing has been saved yet. */
  load(): Promise<IntentGraph | null>;
  /** Save `graph`, or skip if unchanged since the last save/load `rev`. */
  save(graph: IntentGraph): Promise<void>;
}

/** Another writer saved a newer graph since this storage object's last `load()`/`save()`. */
export class StaleIntentGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleIntentGraphError";
  }
}

/** Options for {@link ExperimentalLocalFileIntentGraphStorage}. */
export interface ExperimentalLocalFileIntentGraphStorageOptions {
  /** Path to the JSON file. Parent directory must already exist. */
  readonly path: string;
}

/**
 * Local JSON file storage for an {@link IntentGraph} — the default backend.
 * Writes atomically (temp file + rename) so a crash mid-write cannot leave a
 * truncated file.
 */
export class ExperimentalLocalFileIntentGraphStorage implements ExperimentalIntentGraphStorage {
  private readonly path: string;
  private lastKnownRev: number | undefined;

  constructor(options: ExperimentalLocalFileIntentGraphStorageOptions) {
    this.path = options.path;
  }

  async load(): Promise<IntentGraph | null> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        this.lastKnownRev = undefined;
        return null;
      }
      throw error;
    }
    const graph = IntentGraph.fromJson(text);
    this.lastKnownRev = graph.rev;
    return graph;
  }

  async save(graph: IntentGraph): Promise<void> {
    if (this.lastKnownRev === graph.rev) return;

    const diskRev = await this.readDiskRev();
    if (diskRev !== this.lastKnownRev) {
      throw new StaleIntentGraphError(
        `intent graph at ${this.path} changed since load() (on-disk rev ${diskRev ?? "none"}, ` +
          `expected ${this.lastKnownRev ?? "none"}); load() again and reapply your changes before saving`,
      );
    }

    const tmpPath = join(
      dirname(this.path),
      `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await writeFile(tmpPath, graph.toJson(), "utf8");
    await rename(tmpPath, this.path);
    this.lastKnownRev = graph.rev;
  }

  private async readDiskRev(): Promise<number | undefined> {
    try {
      const text = await readFile(this.path, "utf8");
      return (JSON.parse(text) as { rev?: number }).rev ?? 0;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Extract `<Code>`/`<Message>` from an S3 error response body (standard AWS
 * XML error shape) for a more useful failure message than a bare status code
 * — e.g. distinguishing `SignatureDoesNotMatch` from `AccessDenied` on a 403.
 * Returns `undefined` for a body with no `<Code>` (not an AWS-shaped error).
 */
function describeS3Error(body: string): string | undefined {
  const code = /<Code>([^<]*)<\/Code>/.exec(body)?.[1];
  if (!code) return undefined;
  const message = /<Message>([^<]*)<\/Message>/.exec(body)?.[1];
  return message ? `${code}: ${message}` : code;
}

/** One S3 REST request, as {@link S3Transport} sends it. */
export interface S3Request {
  /** `"GET"` (read the object) or `"PUT"` (write it). */
  readonly method: "GET" | "PUT";
  /** S3 bucket name. */
  readonly bucket: string;
  /** S3 object key. */
  readonly key: string;
  /** Lowercase header names, e.g. `if-match`, `if-none-match`. */
  readonly headers: Readonly<Record<string, string>>;
  /** Request body for a `PUT`; omitted for a `GET`. */
  readonly body?: string;
}

/** Response from an {@link S3Transport} call. */
export interface S3Response {
  /** HTTP status code, e.g. `200`, `404`, `412`. */
  readonly status: number;
  /** Lowercase header names. */
  readonly headers: Readonly<Record<string, string>>;
  /** Response body (the object contents for a successful `GET`). */
  readonly body: string;
}

/**
 * Sends one signed S3 request. The default transport talks to real S3 over
 * `fetch`; tests inject a fake to stay credential-free and offline.
 */
export interface S3Transport {
  /** Send `request` and resolve with the S3 response. */
  send(request: S3Request): Promise<S3Response>;
}

/** Explicit AWS credentials. Falls back to `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN` if omitted. */
export interface ExperimentalS3IntentGraphStorageCredentials {
  /** AWS access key id. */
  readonly accessKeyId: string;
  /** AWS secret access key. */
  readonly secretAccessKey: string;
  /** Session token for temporary (STS) credentials. */
  readonly sessionToken?: string;
}

/** Options for {@link ExperimentalS3IntentGraphStorage}. */
export interface ExperimentalS3IntentGraphStorageOptions {
  /** S3 bucket to store the graph in. */
  readonly bucket: string;
  /** S3 object key, e.g. `"intent-graph.json"`. */
  readonly key: string;
  /** @default "us-east-1" */
  readonly region?: string;
  /** Explicit credentials; falls back to the standard AWS environment variables. */
  readonly credentials?: ExperimentalS3IntentGraphStorageCredentials;
  /**
   * Custom S3-compatible endpoint, e.g. `"http://localhost:9000"` or
   * `"https://minio.internal:9000"`. Omit for AWS S3 (default).
   */
  readonly endpoint?: string;
  /**
   * Path-style addressing (`https://endpoint/bucket/key`) instead of
   * virtual-hosted-style. Defaults to `true` whenever `endpoint` is set —
   * what MinIO and most self-hosted S3-compatible services require. Pass
   * `false` for a custom endpoint that supports virtual-hosted style (e.g.
   * Cloudflare R2). No effect without `endpoint` — AWS S3 always uses
   * virtual-hosted style.
   */
  readonly forcePathStyle?: boolean;
  /** Override the transport, e.g. to inject a fake for tests. Defaults to a `fetch`-based signed S3 client. */
  readonly transport?: S3Transport;
}

function credentialsFromEnv(): ExperimentalS3IntentGraphStorageCredentials {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "AWS credentials not found: pass `credentials` to ExperimentalS3IntentGraphStorage, or " +
        "set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN for temporary credentials).",
    );
  }
  return { accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SESSION_TOKEN };
}

class FetchS3Transport implements S3Transport {
  constructor(
    private readonly region: string,
    private readonly credentials: ExperimentalS3IntentGraphStorageCredentials | undefined,
    private readonly endpoint: string | undefined,
    private readonly forcePathStyle: boolean | undefined,
  ) {}

  async send(request: S3Request): Promise<S3Response> {
    const creds = this.credentials ?? credentialsFromEnv();
    const { scheme, host, path } = resolveS3Endpoint({
      bucket: request.bucket,
      key: request.key,
      region: this.region,
      endpoint: this.endpoint,
      forcePathStyle: this.forcePathStyle,
    });
    const body = request.body ?? "";
    const signed = signS3Request({
      method: request.method,
      host,
      path,
      headers: request.headers,
      body,
      region: this.region,
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    });
    const response = await fetch(`${scheme}://${host}${path}`, {
      method: request.method,
      headers: signed.headers,
      body: request.method === "PUT" ? body : undefined,
    });
    const responseBody = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    return { status: response.status, headers, body: responseBody };
  }
}

/**
 * S3-backed storage for an {@link IntentGraph}. No SDK dependency — signs
 * requests with a built-in minimal SigV4 implementation (`signS3Request`)
 * and sends them with native `fetch` (ADR-0025). Uses S3 conditional writes
 * (`If-Match`/`If-None-Match` on the object's ETag) for stale-base detection;
 * no bucket versioning required.
 */
export class ExperimentalS3IntentGraphStorage implements ExperimentalIntentGraphStorage {
  private readonly bucket: string;
  private readonly key: string;
  private readonly transport: S3Transport;
  private lastKnownEtag: string | undefined;
  private lastKnownRev: number | undefined;

  constructor(options: ExperimentalS3IntentGraphStorageOptions) {
    this.bucket = options.bucket;
    this.key = options.key;
    this.transport =
      options.transport ??
      new FetchS3Transport(
        options.region ?? "us-east-1",
        options.credentials,
        options.endpoint,
        options.forcePathStyle,
      );
  }

  async load(): Promise<IntentGraph | null> {
    const response = await this.transport.send({
      method: "GET",
      bucket: this.bucket,
      key: this.key,
      headers: {},
    });
    if (response.status === 404) {
      this.lastKnownEtag = undefined;
      this.lastKnownRev = undefined;
      return null;
    }
    if (response.status !== 200) {
      const detail = describeS3Error(response.body);
      throw new Error(
        `S3 GetObject failed for s3://${this.bucket}/${this.key} with status ${response.status}` +
          (detail ? ` (${detail})` : ""),
      );
    }
    const graph = IntentGraph.fromJson(response.body);
    this.lastKnownEtag = response.headers.etag;
    this.lastKnownRev = graph.rev;
    return graph;
  }

  async save(graph: IntentGraph): Promise<void> {
    if (this.lastKnownRev === graph.rev) return;

    const headers: Record<string, string> = this.lastKnownEtag
      ? { "if-match": this.lastKnownEtag }
      : { "if-none-match": "*" };

    const response = await this.transport.send({
      method: "PUT",
      bucket: this.bucket,
      key: this.key,
      headers,
      body: graph.toJson(),
    });

    if (response.status === 412) {
      throw new StaleIntentGraphError(
        `intent graph at s3://${this.bucket}/${this.key} changed since load(); ` +
          `load() again and reapply your changes before saving`,
      );
    }
    if (response.status !== 200) {
      const detail = describeS3Error(response.body);
      throw new Error(
        `S3 PutObject failed for s3://${this.bucket}/${this.key} with status ${response.status}` +
          (detail ? ` (${detail})` : ""),
      );
    }
    this.lastKnownEtag = response.headers.etag;
    this.lastKnownRev = graph.rev;
  }
}
