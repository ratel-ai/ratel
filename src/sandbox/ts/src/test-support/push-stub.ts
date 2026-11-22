import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// A stub of the Ratel push API (protocol/sandbox/v1/schema/push), for tests and
// demos of `ratel sandbox push`. It checks each request body against the push
// schemas, keeps the uploaded bundles in memory and records every call in
// order. Test support only: not the Ratel server.

export interface PushStubCall {
  readonly method: string;
  readonly path: string;
  /** The Authorization header, or undefined. */
  readonly authorization?: string;
  readonly body?: unknown;
  readonly bytes?: number;
}

export interface PushStub {
  readonly url: string;
  readonly calls: readonly PushStubCall[];
  /** The uploaded bundles by version id. */
  readonly bundles: ReadonlyMap<string, Buffer>;
  close(): Promise<void>;
}

export interface PushStubOptions {
  readonly port?: number;
  /** The project key the stub accepts. Default: any `rtl_` key. */
  readonly apiKey?: string;
  /** Answer finalize with this status. Default: building. */
  readonly status?: "building" | "ready" | "failed";
}

const SCHEMA_DIR = fileURLToPath(
  new URL("../../../../../protocol/sandbox/v1/schema", import.meta.url),
);
const VERSIONS = "/api/v1/sandboxes/versions";

export async function startPushStub(options: PushStubOptions = {}): Promise<PushStub> {
  const validators = pushValidators();
  const calls: PushStubCall[] = [];
  const bundles = new Map<string, Buffer>();
  const versions = new Map<string, { sandboxId: string; sha256: string }>();
  let base = "";

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://stub").pathname;
    const raw = await readBody(req);
    const authorization = req.headers.authorization;
    const record = (body?: unknown) =>
      calls.push({
        method: req.method ?? "",
        path,
        ...(authorization ? { authorization } : {}),
        ...(body !== undefined ? { body } : { bytes: raw.length }),
      });

    if (req.method === "PUT" && path.startsWith("/upload/")) {
      record();
      bundles.set(decodeURIComponent(path.slice("/upload/".length)), raw);
      return send(res, 200, {});
    }
    const body = parseJson(raw);
    record(body);
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    if (!authorized(authorization, options.apiKey))
      return send(res, 401, { error: "invalid project key" });

    if (path === VERSIONS) {
      const problem = check(validators["create-version.request"], body);
      if (problem) return send(res, 400, { error: problem });
      const request = body as { sandboxId: string; bundle: { sha256: string } };
      const versionId = `sv_${String(versions.size + 1).padStart(4, "0")}`;
      versions.set(versionId, { sandboxId: request.sandboxId, sha256: request.bundle.sha256 });
      const known = [...bundles.values()].some((b) => sha256(b) === request.bundle.sha256);
      return send(
        res,
        201,
        known
          ? { versionId }
          : {
              versionId,
              uploadUrl: `${base}/upload/${versionId}`,
              uploadHeaders: { "content-type": "application/gzip" },
            },
      );
    }
    const finalize = /^\/api\/v1\/sandboxes\/versions\/([^/]+)\/finalize$/.exec(path);
    if (finalize) {
      const versionId = decodeURIComponent(finalize[1] as string);
      const version = versions.get(versionId);
      if (!version) return send(res, 404, { error: `unknown version ${versionId}` });
      const problem = check(validators["finalize.request"], body);
      if (problem) return send(res, 400, { error: problem });
      const uploaded = [...bundles.values()].find((b) => sha256(b) === version.sha256);
      if (!uploaded || (body as { sha256: string }).sha256 !== version.sha256)
        return send(res, 409, { error: "the uploaded bundle does not match the sha256" });
      return send(res, 200, {
        status: options.status ?? "building",
        playgroundUrl: `${base}/sandboxes/${version.sandboxId}/versions/${versionId}`,
        ...(options.status === "failed" ? { error: "the image build failed (stub)" } : {}),
      });
    }
    return send(res, 404, { error: `no route ${path}` });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    calls,
    bundles,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function pushValidators(): Record<string, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
  (addFormatsModule as unknown as (a: Ajv2020) => void)(ajv);
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".schema.json")) ajv.addSchema(JSON.parse(readFileSync(p, "utf8")));
    }
  };
  walk(SCHEMA_DIR);
  const get = (name: string) => {
    const validate = ajv.getSchema(`https://ratel.sh/protocol/sandbox/v1/push/${name}.schema.json`);
    if (!validate) throw new Error(`no push schema ${name}`);
    return validate;
  };
  return {
    "create-version.request": get("create-version.request"),
    "finalize.request": get("finalize.request"),
  };
}

function authorized(header: string | undefined, key: string | undefined): boolean {
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  return token !== undefined && (key ? token === key : token.startsWith("rtl_"));
}

function check(validate: ValidateFunction | undefined, body: unknown): string | null {
  if (!validate || validate(body)) return null;
  return `invalid request: ${JSON.stringify(validate.errors?.slice(0, 3))}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(raw: Buffer): unknown {
  try {
    return raw.length > 0 ? JSON.parse(raw.toString("utf8")) : undefined;
  } catch {
    return undefined;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
