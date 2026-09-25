import { createHash, createHmac } from "node:crypto";

/**
 * Minimal AWS Signature Version 4 signer for S3 REST requests. Exists so
 * {@link S3IntentGraphStorage} needs no `@aws-sdk/client-s3`
 * dependency — everything here is Node built-ins (`node:crypto`, native
 * `fetch`). See ADR-0025.
 */

/** Inputs to {@link signS3Request}. */
export interface SignS3RequestOptions {
  readonly method: "GET" | "PUT";
  /** Virtual-hosted-style host, e.g. `my-bucket.s3.us-east-1.amazonaws.com`. */
  readonly host: string;
  /** Absolute path, e.g. `/intent-graph.json`. Not URL-encoded beyond RFC 3986 unreserved chars. */
  readonly path: string;
  /** Extra headers to sign and send (lowercase keys), e.g. `range`, `if-match`. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  /** Overridable for deterministic tests; defaults to `new Date()`. */
  readonly date?: Date;
}

/** A signed request ready to send: every header (signed + `authorization`), lowercase keys. */
export interface SignedS3Request {
  readonly headers: Record<string, string>;
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function amzDate(date: Date): { full: string; dateOnly: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { full: iso, dateOnly: iso.slice(0, 8) };
}

/**
 * Percent-encode `value` per AWS's SigV4 UriEncode rules: every byte except
 * unreserved characters (`A-Za-z0-9-._~`). `encodeURIComponent` alone
 * under-escapes — it leaves `!*'()` unescaped, which AWS's canonicalization
 * does not — so those five are escaped on top of it. Matches Python's
 * `urllib.parse.quote(part, safe="")`, which is already spec-correct.
 */
export function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Where an {@link resolveS3Endpoint} request should go. */
export interface S3EndpointTarget {
  readonly scheme: "http" | "https";
  /** Includes the port when non-default, e.g. `"localhost:9000"`. */
  readonly host: string;
  /** Leading slash; key percent-encoded; bucket-prefixed iff path-style. */
  readonly path: string;
}

/** Inputs to {@link resolveS3Endpoint}. */
export interface ResolveS3EndpointOptions {
  readonly bucket: string;
  readonly key: string;
  readonly region: string;
  /** Custom S3-compatible endpoint, e.g. `"http://localhost:9000"`. Omit for AWS S3. */
  readonly endpoint?: string;
  /**
   * Path-style addressing (`https://endpoint/bucket/key`) instead of
   * virtual-hosted-style. Defaults to `true` whenever `endpoint` is set —
   * what MinIO and most self-hosted S3-compatible services require, since
   * virtual-hosted style needs a wildcard DNS/TLS setup most self-hosted
   * deployments don't have. Pass `false` for a custom endpoint that does
   * support virtual-hosted style (e.g. Cloudflare R2). No effect without
   * `endpoint` — AWS S3 always uses virtual-hosted style.
   */
  readonly forcePathStyle?: boolean;
}

/**
 * Resolve the scheme/host/path an S3 (or S3-compatible) request targets.
 * Pure and network-free so endpoint/path-style logic is unit-testable
 * without a live server.
 */
export function resolveS3Endpoint(options: ResolveS3EndpointOptions): S3EndpointTarget {
  const encodedKey = options.key.split("/").map(awsUriEncode).join("/");

  if (!options.endpoint) {
    return {
      scheme: "https",
      host: `${options.bucket}.s3.${options.region}.amazonaws.com`,
      path: `/${encodedKey}`,
    };
  }

  const endpointUrl = parseEndpoint(options.endpoint);
  const scheme = endpointUrl.protocol === "http:" ? "http" : "https";
  // A gateway mounted under a prefix keeps it: it is part of the canonical URI,
  // so dropping it signs one path and addresses another.
  const prefix = endpointUrl.pathname.replace(/\/+$/, "");
  const pathStyle = options.forcePathStyle ?? true;

  return pathStyle
    ? { scheme, host: endpointUrl.host, path: `${prefix}/${options.bucket}/${encodedKey}` }
    : { scheme, host: `${options.bucket}.${endpointUrl.host}`, path: `${prefix}/${encodedKey}` };
}

/**
 * Parse `endpoint`, rejecting anything that is not an absolute http(s) URL.
 *
 * `new URL("minio.internal:9000")` does not throw: it reads the host as a
 * scheme and leaves the host empty, which would send a fully signed request,
 * `Authorization` and session token included, to whatever the bucket name
 * resolves to.
 */
function parseEndpoint(endpoint: string): URL {
  const invalid = () =>
    new Error(
      `invalid endpoint ${JSON.stringify(endpoint)}: expected an absolute ` +
        `http(s) URL, e.g. "http://localhost:9000"`,
    );
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw invalid();
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.host === "") throw invalid();
  return url;
}

/** Sign an S3 request per AWS SigV4. Returns the full header set to send. */
export function signS3Request(options: SignS3RequestOptions): SignedS3Request {
  const date = options.date ?? new Date();
  const { full: amzDateStr, dateOnly } = amzDate(date);
  const payloadHash = sha256Hex(options.body);

  // Lowercased on the way in: the canonical form is lowercase, and indexing the
  // original bag with a lowercased name misses a caller's mixed-case key.
  const headers: Record<string, string> = Object.fromEntries(
    Object.entries({
      ...options.headers,
      host: options.host,
      "x-amz-date": amzDateStr,
      "x-amz-content-sha256": payloadHash,
      ...(options.sessionToken ? { "x-amz-security-token": options.sessionToken } : {}),
    }).map(([name, value]) => [name.toLowerCase(), value]),
  );

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name].trim()}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    options.method,
    options.path,
    "", // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateOnly}/${options.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDateStr,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${options.secretAccessKey}`, dateOnly);
  const kRegion = hmac(kDate, options.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { headers: { ...headers, authorization } };
}
