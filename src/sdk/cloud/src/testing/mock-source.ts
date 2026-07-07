/**
 * In-process catalog source for tests: the source side of the frozen
 * protocol/v1 contract on a `node:http` server bound to port 0. Serves the
 * real ETag algorithm and scope overlay from `../canonical.js`, weak
 * `If-None-Match` matching, frozen error bodies, Bearer auth, request
 * recording, and per-endpoint failure injection. Pinned against
 * `protocol/v1/conformance/vectors.json` in its own test.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type CatalogSkillWire,
  etagOf,
  projectSkill,
  resolveScope,
  type SourceLayers,
} from "../canonical.js";

export interface RecordedRequest {
  method: string;
  path: string;
  scope: string | null;
  ifNoneMatch: string | null;
  authorization: string | null;
}

export type InjectedFailure =
  | { kind: "http"; status: number; code?: string; message?: string }
  | { kind: "network" };

export type MockEndpoint = "catalog" | "healthz";

export interface MockSourceOptions {
  /** Bearer key the source accepts (default `"test-key"`). */
  apiKey?: string;
}

/**
 * Weak `If-None-Match` comparison (RFC 7232 §3.2): tolerates a `W/` prefix,
 * surrounding quotes, comma lists, and `*`. v1 ETags are comma-free hex, so a
 * plain split is sufficient.
 */
export function ifNoneMatchMatches(headerValue: string | null, currentEtag: string): boolean {
  if (headerValue == null) return false;
  const opaque = (tag: string): string => {
    let t = tag.trim();
    if (t.startsWith("W/")) t = t.slice(2).trim();
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
    return t;
  };
  const v = headerValue.trim();
  if (v === "*") return true;
  const current = opaque(currentEtag);
  return v.split(",").some((tok) => {
    const o = opaque(tok);
    return o.length > 0 && o === current;
  });
}

const CODE_BY_STATUS: Record<number, string> = {
  400: "invalid_request",
  401: "unauthorized",
  404: "not_found",
  503: "unavailable",
};

export class MockSource {
  readonly url: string;
  readonly apiKey: string;
  readonly requests: RecordedRequest[] = [];

  private layers: SourceLayers = { global: [] };
  private readonly failures = new Map<MockEndpoint, InjectedFailure>();
  private readonly server: Server;

  constructor(server: Server, url: string, apiKey: string) {
    this.server = server;
    this.url = url;
    this.apiKey = apiKey;
  }

  /** Replace the source's layers with a global-only set. */
  setSkills(skills: CatalogSkillWire[]): void {
    this.layers = { global: skills };
  }

  /** Replace the source's full layer set (global + per-subject overlays). */
  setLayers(layers: SourceLayers): void {
    this.layers = layers;
  }

  /** Inject a persistent failure on one endpoint; pass `undefined` to clear it. */
  failWith(endpoint: MockEndpoint, failure: InjectedFailure | undefined): void {
    if (failure === undefined) this.failures.delete(endpoint);
    else this.failures.set(endpoint, failure);
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /** @internal request handler wired up by {@link startMockSource}. */
  handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    const url = new URL(req.url ?? "/", this.url);
    this.requests.push({
      method: req.method ?? "",
      path: url.pathname,
      scope: url.searchParams.get("scope"),
      ifNoneMatch: req.headers["if-none-match"] ?? null,
      authorization: req.headers.authorization ?? null,
    });

    if (url.pathname === "/healthz") {
      if (this.injectFailure("healthz", res)) return;
      res.writeHead(200).end();
      return;
    }

    if (url.pathname === "/v1/catalog" && req.method === "GET") {
      if (this.injectFailure("catalog", res)) return;
      if (req.headers.authorization !== `Bearer ${this.apiKey}`) {
        this.error(res, 401);
        return;
      }
      const resolved = resolveScope(this.layers, url.searchParams.get("scope")).map(projectSkill);
      const { hex, etag } = etagOf(resolved);
      if (ifNoneMatchMatches(req.headers["if-none-match"] ?? null, etag)) {
        res.writeHead(304, { etag }).end();
        return;
      }
      res
        .writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-cache",
          etag,
        })
        .end(JSON.stringify({ catalogVersion: hex, skills: resolved }));
      return;
    }

    this.error(res, 404);
  }

  private injectFailure(endpoint: MockEndpoint, res: import("node:http").ServerResponse): boolean {
    const failure = this.failures.get(endpoint);
    if (!failure) return false;
    if (failure.kind === "network") {
      res.destroy();
      return true;
    }
    this.error(res, failure.status, failure.code, failure.message);
    return true;
  }

  private error(
    res: import("node:http").ServerResponse,
    status: number,
    code = CODE_BY_STATUS[status] ?? "invalid_request",
    message = `mock source: ${status}`,
  ): void {
    res
      .writeHead(status, { "content-type": "application/json" })
      .end(JSON.stringify({ error: { code, message } }));
  }
}

/** Start a mock source on an ephemeral loopback port. */
export function startMockSource(options: MockSourceOptions = {}): Promise<MockSource> {
  return new Promise((resolve, reject) => {
    let source: MockSource;
    const server = createServer((req, res) => source.handle(req, res));
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      source = new MockSource(server, `http://127.0.0.1:${port}`, options.apiKey ?? "test-key");
      resolve(source);
    });
  });
}
