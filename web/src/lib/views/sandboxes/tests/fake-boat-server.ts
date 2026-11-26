import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ExecResult } from "../ports/sandbox-provider";
import { runFakeShell } from "./fake-shell";

/** A local HTTP server that answers like the v1 API of the VM service, with its state in memory. */
export type FakeBoatServer = {
  /** The API base URL, e.g. `http://127.0.0.1:1234/api/v1`. */
  url: string;
  /** Every request, in order. */
  requests: RecordedRequest[];
  sandboxes: Map<string, FakeSandbox>;
  snapshots: Map<string, FakeSnapshot>;
  /** An answer for a request instead of the normal one; undefined keeps the normal one. */
  intercept: (request: RecordedRequest) => Answer | undefined;
  /** Runs a command; the fake shell by default. */
  shell: (sandbox: FakeSandbox, command: string, timeoutS: number) => ExecResult;
  /** GET polls before a new sandbox is ready. */
  pollsUntilReady: number;
  /** GET polls before a saved snapshot settles. */
  pollsUntilSaved: number;
  /** The state a saved snapshot settles at. */
  savedState: "ready" | "failed";
  /** The sandboxes of one list page. */
  pageSize: number;
  close(): Promise<void>;
};

export type RecordedRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: Buffer;
  json: Record<string, unknown> | null;
};

export type Answer = { status: number; body?: unknown; headers?: Record<string, string> };

export type FakeSandbox = {
  id: string;
  state: string;
  polls: number;
  labels: Record<string, string>;
  createdAt: string;
  files: Map<string, Buffer>;
  create: Record<string, unknown>;
};

type FakeSnapshot = { name: string; status: string; polls: number; files: Map<string, Buffer> };

const INLINE_MAX_BYTES = 5 * 1024 * 1024;

export async function startFakeBoatServer(): Promise<FakeBoatServer> {
  const uploads = new Map<string, { sandboxId: string; path: string }>();
  const processes = new Map<number, ExecResult>();
  let next = 0;
  const fake: FakeBoatServer = {
    url: "",
    requests: [],
    sandboxes: new Map(),
    snapshots: new Map(),
    intercept: () => undefined,
    shell: (sandbox, command, timeoutS) => runFakeShell(command, sandbox.files, timeoutS),
    pollsUntilReady: 1,
    pollsUntilSaved: 1,
    savedState: "ready",
    pageSize: 100,
    close: async () => {},
  };

  const route = (request: RecordedRequest): Answer => {
    const { method, path, json } = request;
    const parts = path.replace(/^\/(api\/v1\/)?/, "").split("/");
    if (parts[0] === "upload" && method === "PUT") {
      const target = uploads.get(parts[1] ?? "");
      const sandbox = target && fake.sandboxes.get(target.sandboxId);
      if (!target || !sandbox) return error(404, "not_found");
      sandbox.files.set(target.path, request.body);
      return { status: 200, body: { ok: true } };
    }
    if (parts[0] === "sandboxes" && parts.length === 1) {
      if (method === "POST") return create(json ?? {});
      if (method === "GET") return list(request.query);
    }
    if (parts[0] === "sandboxes" && parts[1]) {
      const sandbox = fake.sandboxes.get(parts[1]);
      if (!sandbox) return error(404, "not_found");
      return onSandbox(sandbox, parts.slice(2), request);
    }
    if (parts[0] === "saved-snapshots") return onSnapshot(parts[1], request);
    return error(404, "not_found");
  };

  const create = (body: Record<string, unknown>): Answer => {
    const from = typeof body.from === "string" ? fake.snapshots.get(body.from) : undefined;
    if (body.from && from?.status !== "ready") return error(404, "not_found");
    const id = `bx_${(next++).toString().padStart(8, "2")}`;
    const sandbox: FakeSandbox = {
      id,
      state: "provisioning",
      polls: 0,
      labels: { ...((body.labels as Record<string, string>) ?? {}) },
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, next)).toISOString(),
      files: new Map(from?.files ?? []),
      create: body,
    };
    fake.sandboxes.set(id, sandbox);
    return { status: 202, body: { ok: true, status: "provisioning", sandbox: view(sandbox) } };
  };

  const list = (query: URLSearchParams): Answer => {
    const wanted = query.getAll("label").map((label) => label.split("="));
    const all = [...fake.sandboxes.values()].filter((sandbox) =>
      wanted.every(([key, value]) => sandbox.labels[key ?? ""] === value),
    );
    const start = Number(query.get("cursor") ?? 0);
    const page = all.slice(start, start + fake.pageSize);
    const end = start + page.length;
    return {
      status: 200,
      body: {
        ok: true,
        sandboxes: page.map(view),
        pageInfo: { nextCursor: end < all.length ? String(end) : null, hasMore: end < all.length },
      },
    };
  };

  const onSandbox = (sandbox: FakeSandbox, rest: string[], request: RecordedRequest): Answer => {
    const { method, json, query } = request;
    const [what, id] = rest;
    if (!what && method === "GET") {
      sandbox.polls += 1;
      if (sandbox.state === "provisioning" && sandbox.polls >= fake.pollsUntilReady) {
        sandbox.state = "ready";
      }
      return { status: 200, body: { ok: true, sandbox: view(sandbox) } };
    }
    if (!what && method === "DELETE") {
      if (request.headers["x-ascii-confirm-delete"] !== sandbox.id) return error(409, "confirm");
      fake.sandboxes.delete(sandbox.id);
      return { status: 202, body: { ok: true, operation: { id: "bdop_1" } } };
    }
    if (what === "commands" && method === "POST" && !id) {
      const timeoutS = Number(json?.timeoutSeconds ?? 30);
      if (timeoutS < 1 || timeoutS > 600) return error(400, "invalid_timeout");
      const result = fake.shell(sandbox, String(json?.command), timeoutS);
      if (json?.detached) {
        const processId = processes.size + 1;
        processes.set(processId, result);
        return { status: 200, body: { ok: true, success: true, processId, pid: 99 } };
      }
      return { status: 200, body: { ok: true, success: result.exitCode === 0, ...result } };
    }
    if (what === "commands" && method === "GET" && id) {
      const result = processes.get(Number(id));
      if (!result) return error(404, "not_found");
      const exited = { status: "exited", running: false, processId: Number(id) };
      return { status: 200, body: { ok: true, success: true, ...exited, ...result } };
    }
    if (what === "files" && !id && method === "PUT") {
      const content = Buffer.from(String(json?.content ?? ""), "base64");
      if (content.length > INLINE_MAX_BYTES) return error(413, "file_too_large");
      const path = String(json?.path);
      if (!allowed(path)) return error(400, "invalid_path");
      sandbox.files.set(path, content);
      return { status: 200, body: { ok: true } };
    }
    if (what === "files" && !id && method === "DELETE") {
      sandbox.files.delete(query.get("path") ?? "");
      return { status: 200, body: { ok: true } };
    }
    if (what === "files" && id === "upload-url" && method === "POST") {
      const path = String(json?.path);
      if (!allowed(path)) return error(400, "invalid_path");
      const network = sandbox.create.network as { inbound?: string } | undefined;
      if (network?.inbound === "boat-only") return error(403, "inbound_closed");
      const token = randomBytes(8).toString("hex");
      uploads.set(token, { sandboxId: sandbox.id, path });
      const url = `${fake.url.replace(/\/api\/v1$/, "")}/upload/${token}`;
      return { status: 200, body: { ok: true, url, method: "PUT", path } };
    }
    return error(404, "not_found");
  };

  const onSnapshot = (name: string | undefined, request: RecordedRequest): Answer => {
    const { method, json } = request;
    if (!name && method === "GET") {
      const all = [...fake.snapshots.values()];
      const start = Number(request.query.get("cursor") ?? 0);
      const page = all.slice(start, start + fake.pageSize);
      const end = start + page.length;
      return {
        status: 200,
        body: {
          ok: true,
          snapshots: page.map(({ name, status }) => ({ name, status })),
          pageInfo: {
            nextCursor: end < all.length ? String(end) : null,
            hasMore: end < all.length,
          },
        },
      };
    }
    if (!name && method === "POST") {
      const sandbox = fake.sandboxes.get(String(json?.sandboxId));
      if (!sandbox) return error(404, "not_found");
      if (sandbox.create.snapshots === false) return error(409, "snapshots_off");
      const snapshot = {
        name: String(json?.name),
        status: "saving",
        polls: 0,
        files: new Map(sandbox.files),
      };
      fake.snapshots.set(snapshot.name, snapshot);
      return {
        status: 202,
        body: { ok: true, status: "saving", snapshot: { name: snapshot.name, status: "saving" } },
      };
    }
    const snapshot = fake.snapshots.get(name ?? "");
    if (!snapshot) return error(404, "not_found");
    if (method === "GET") {
      snapshot.polls += 1;
      if (snapshot.status === "saving" && snapshot.polls >= fake.pollsUntilSaved) {
        snapshot.status = fake.savedState;
      }
      const failed = snapshot.status === "failed" ? { error: "capture broke on boat host" } : {};
      return {
        status: 200,
        body: { ok: true, snapshot: { name: snapshot.name, status: snapshot.status, ...failed } },
      };
    }
    if (method === "DELETE") {
      fake.snapshots.delete(snapshot.name);
      return { status: 200, body: { ok: true } };
    }
    return error(404, "not_found");
  };

  const server = createServer(async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(incoming.url ?? "/", "http://x");
    let json: Record<string, unknown> | null = null;
    if (incoming.headers["content-type"]?.includes("json") && body.length > 0) {
      json = JSON.parse(body.toString()) as Record<string, unknown>;
    }
    const request: RecordedRequest = {
      method: incoming.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers: incoming.headers,
      body,
      json,
    };
    fake.requests.push(request);
    const answer = fake.intercept(request) ?? route(request);
    outgoing.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
    outgoing.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  fake.url = `http://127.0.0.1:${port}/api/v1`;
  fake.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fake;
}

/** An error answer in the envelope of the service. */
export function error(status: number, code: string, more: Record<string, unknown> = {}): Answer {
  const message = `boat error ${code}`;
  return {
    status,
    body: { ok: false, status, code, message, error: { code, message, status }, ...more },
  };
}

function view(sandbox: FakeSandbox) {
  const { id, state, labels, createdAt } = sandbox;
  return { id, name: id, state, labels, createdAt };
}

function allowed(path: string): boolean {
  return path.startsWith("/home/user/") || path.startsWith("/tmp/");
}
