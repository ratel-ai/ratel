import { createHash, createHmac } from "node:crypto";

/**
 * Minimal AWS Signature Version 4 signer for S3 REST requests. Exists so
 * {@link ExperimentalS3IntentGraphStorage} needs no `@aws-sdk/client-s3`
 * dependency — everything here is Node built-ins (`node:crypto`, native
 * `fetch`). See ADR-0025.
 */

/** Inputs to {@link signS3Request}. */
export interface SignS3RequestOptions {
  readonly method: "GET" | "PUT" | "HEAD";
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

/** Sign an S3 request per AWS SigV4. Returns the full header set to send. */
export function signS3Request(options: SignS3RequestOptions): SignedS3Request {
  const date = options.date ?? new Date();
  const { full: amzDateStr, dateOnly } = amzDate(date);
  const payloadHash = sha256Hex(options.body);

  const headers: Record<string, string> = {
    ...options.headers,
    host: options.host,
    "x-amz-date": amzDateStr,
    "x-amz-content-sha256": payloadHash,
    ...(options.sessionToken ? { "x-amz-security-token": options.sessionToken } : {}),
  };

  const signedHeaderNames = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
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
