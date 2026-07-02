import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { CatalogSkillWire, Suggestion } from "../types.js";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface MockCloud {
  url: string;
  apiKey: string;
  requests: RecordedRequest[];
  /** Replace the published catalog (bumps the ETag/catalogVersion). */
  setSkills(skills: CatalogSkillWire[], version: string): void;
  suggestions: Suggestion[];
  /** Override the trace-events responder (status + body) for failure tests. */
  traceEventsResponder?: (body: unknown) => { status: number; payload: unknown };
  /** Override the run-metrics responder. */
  runMetricsResponder?: (body: unknown) => { status: number; payload: unknown };
  close(): Promise<void>;
}

/**
 * In-process stand-in for Ratel Cloud's project-key API surface, encoding the
 * shipped contracts: `GET /api/v1/catalog` (Bearer + ETag/If-None-Match),
 * `POST /api/v1/trace-events` (batch, 202 `{accepted, rejected}`),
 * `POST /api/v1/events`, and the companion `/api/v1/suggestions` REST.
 */
export async function startMockCloud(
  opts: { apiKey?: string; skills?: CatalogSkillWire[]; version?: string } = {},
): Promise<MockCloud> {
  const apiKey = opts.apiKey ?? "rtl_test_key";
  let skills = opts.skills ?? [];
  let version = opts.version ?? "v0";

  const mock: MockCloud = {
    url: "",
    apiKey,
    requests: [],
    setSkills(next, nextVersion) {
      skills = next;
      version = nextVersion;
    },
    suggestions: [],
    close: async () => {},
  };

  const handler = (req: IncomingMessage, res: ServerResponse, body: unknown): void => {
    const path = (req.url ?? "").split("?")[0];
    const auth = req.headers.authorization ?? "";
    if (!/^Bearer\s+/i.test(auth) || auth.replace(/^Bearer\s+/i, "").trim() !== apiKey) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    if (req.method === "GET" && path === "/api/v1/catalog") {
      const etag = `"${version}"`;
      const ifNoneMatch = req.headers["if-none-match"];
      if (ifNoneMatch && ifNoneMatch === etag) {
        res.writeHead(304, { etag });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", etag });
      res.end(JSON.stringify({ catalogVersion: version, skills }));
      return;
    }

    if (req.method === "POST" && path === "/api/v1/trace-events") {
      const custom = mock.traceEventsResponder?.(body);
      const events = Array.isArray(body) ? body : [body];
      const status = custom?.status ?? 202;
      const payload = custom?.payload ?? { accepted: events.length, rejected: [] };
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    if (req.method === "POST" && path === "/api/v1/events") {
      const custom = mock.runMetricsResponder?.(body);
      const events = Array.isArray(body) ? body : [body];
      const status = custom?.status ?? 202;
      const payload = custom?.payload ?? { accepted: events.length };
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    if (path?.startsWith("/api/v1/suggestions")) {
      handleSuggestions(req, res, path, body, mock);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      mock.requests.push({
        method: req.method ?? "",
        path: (req.url ?? "").split("?")[0],
        headers: req.headers,
        body,
      });
      handler(req, res, body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  mock.url = `http://127.0.0.1:${address.port}`;
  mock.close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  return mock;
}

/** Companion REST contract (ADR-0014 §suggestions) — list/get/approve/reject/generate. */
function handleSuggestions(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  body: unknown,
  mock: MockCloud,
): void {
  const json = (status: number, payload: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const url = new URL(req.url ?? "", "http://mock");

  if (req.method === "GET" && path === "/api/v1/suggestions") {
    let items = mock.suggestions;
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    if (status) items = items.filter((s) => s.status === status);
    if (type) items = items.filter((s) => s.type === type);
    const limit = Number(url.searchParams.get("limit") ?? "50");
    items = items.slice(0, limit);
    json(200, { count: items.length, suggestions: items });
    return;
  }

  if (req.method === "POST" && path === "/api/v1/suggestions/generate") {
    json(202, { jobId: "job-1", coalesced: false });
    return;
  }

  const idMatch = path.match(/^\/api\/v1\/suggestions\/([^/]+)(\/(approve|reject))?$/);
  if (!idMatch) {
    json(404, { error: "not_found" });
    return;
  }
  const suggestion = mock.suggestions.find((s) => s.id === idMatch[1]);
  if (!suggestion) {
    json(404, { error: "not_found" });
    return;
  }

  if (req.method === "GET" && !idMatch[2]) {
    json(200, { suggestion });
    return;
  }
  if (req.method === "POST" && idMatch[3] === "approve") {
    if (suggestion.status !== "pending") {
      json(409, { error: "conflict", reason: "not_pending" });
      return;
    }
    suggestion.status = "approved";
    json(200, { suggestion });
    return;
  }
  if (req.method === "POST" && idMatch[3] === "reject") {
    if (suggestion.status !== "pending") {
      json(409, { error: "conflict", reason: "not_pending" });
      return;
    }
    suggestion.status = "rejected";
    void body;
    json(200, { suggestion });
    return;
  }
  json(404, { error: "not_found" });
}
