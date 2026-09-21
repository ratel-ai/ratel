import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExperimentalLocalFileIntentGraphStorage,
  ExperimentalS3IntentGraphStorage,
  type S3Transport,
  StaleIntentGraphError,
} from "./intent-graph-storage.js";
import { signS3Request } from "./sigv4.js";

const V1_EMPTY_GRAPH = { v: 1, built_from_ts: 0, rev: 0, intents: [] };

function graphJson(rev: number): string {
  return JSON.stringify({ ...V1_EMPTY_GRAPH, rev });
}

describe("ExperimentalLocalFileIntentGraphStorage", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tempPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ratel-intent-graph-"));
    dirs.push(dir);
    return join(dir, "intent-graph.json");
  }

  it("returns null on load() when the file does not exist", async () => {
    const storage = new ExperimentalLocalFileIntentGraphStorage({ path: await tempPath() });
    await expect(storage.load()).resolves.toBeNull();
  });

  it("round-trips a saved graph, preserving rev", async () => {
    const path = await tempPath();
    const storage = new ExperimentalLocalFileIntentGraphStorage({ path });
    const graph = (await import("./index.js")).IntentGraph.fromJson(graphJson(3));
    await storage.save(graph);

    const other = new ExperimentalLocalFileIntentGraphStorage({ path });
    const loaded = await other.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.rev).toBe(3);
  });

  it("writes atomically via a temp file + rename", async () => {
    const path = await tempPath();
    const storage = new ExperimentalLocalFileIntentGraphStorage({ path });
    const { IntentGraph } = await import("./index.js");
    await storage.save(IntentGraph.fromJson(graphJson(1)));

    const contents = await readFile(path, "utf8");
    expect(JSON.parse(contents).rev).toBe(1);
    const dir = join(path, "..");
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    expect(entries.every((entry) => !entry.includes(".tmp-"))).toBe(true);
  });

  it("skips the write when rev is unchanged since the last save", async () => {
    const path = await tempPath();
    const storage = new ExperimentalLocalFileIntentGraphStorage({ path });
    const { IntentGraph } = await import("./index.js");
    const graph = IntentGraph.fromJson(graphJson(5));
    await storage.save(graph);
    const firstMtime = (await import("node:fs/promises").then((m) => m.stat(path))).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await storage.save(graph);
    const secondMtime = (await import("node:fs/promises").then((m) => m.stat(path))).mtimeMs;
    expect(secondMtime).toBe(firstMtime);
  });

  it("raises StaleIntentGraphError when the on-disk rev moved since load()", async () => {
    const path = await tempPath();
    const { IntentGraph } = await import("./index.js");
    const writer1 = new ExperimentalLocalFileIntentGraphStorage({ path });
    await writer1.save(IntentGraph.fromJson(graphJson(1)));

    const reader = new ExperimentalLocalFileIntentGraphStorage({ path });
    const loaded = await reader.load();
    expect(loaded?.rev).toBe(1);

    // Someone else loads the current graph and advances it on disk.
    const writer2 = new ExperimentalLocalFileIntentGraphStorage({ path });
    await writer2.load();
    await writer2.save(IntentGraph.fromJson(graphJson(2)));

    // reader now has its own local change (rev 3); saving it should detect the clobber
    // caused by writer2, since reader's base (rev 1) no longer matches what's on disk (rev 2).
    await expect(reader.save(IntentGraph.fromJson(graphJson(3)))).rejects.toThrow(
      StaleIntentGraphError,
    );
  });

  it("raises StaleIntentGraphError on first save if the file already exists and was never loaded", async () => {
    const path = await tempPath();
    const { IntentGraph } = await import("./index.js");
    const writer1 = new ExperimentalLocalFileIntentGraphStorage({ path });
    await writer1.save(IntentGraph.fromJson(graphJson(1)));

    const blindWriter = new ExperimentalLocalFileIntentGraphStorage({ path });
    await expect(blindWriter.save(IntentGraph.fromJson(graphJson(1)))).rejects.toThrow(
      StaleIntentGraphError,
    );
  });
});

describe("signS3Request (SigV4)", () => {
  const baseRequest = {
    method: "GET" as const,
    host: "examplebucket.s3.amazonaws.com",
    path: "/test.txt",
    headers: { range: "bytes=0-9" },
    body: "",
    region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    date: new Date("2013-05-24T00:00:00Z"),
  };

  it("is deterministic for identical inputs", () => {
    expect(signS3Request(baseRequest).headers.authorization).toBe(
      signS3Request(baseRequest).headers.authorization,
    );
  });

  it("changes the signature when the secret key changes", () => {
    const a = signS3Request(baseRequest).headers.authorization;
    const b = signS3Request({ ...baseRequest, secretAccessKey: "different-secret" }).headers
      .authorization;
    expect(a).not.toBe(b);
  });

  it("changes the signature when the body changes", () => {
    const a = signS3Request(baseRequest).headers.authorization;
    const b = signS3Request({ ...baseRequest, body: "some content" }).headers.authorization;
    expect(a).not.toBe(b);
  });

  it("builds the canonical SignedHeaders list per the AWS SigV4 spec (sorted, lowercase)", () => {
    // https://docs.aws.amazon.com/general/latest/gr/create-signed-request.html
    const signed = signS3Request(baseRequest);
    expect(signed.headers.authorization).toContain(
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date",
    );
    expect(signed.headers.authorization).toContain(
      "Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
    );
  });

  it("hashes an empty body to the well-known SHA-256 empty-string digest", () => {
    const signed = signS3Request(baseRequest);
    expect(signed.headers["x-amz-content-sha256"]).toBe(
      createHash("sha256").update("").digest("hex"),
    );
  });
});

describe("ExperimentalS3IntentGraphStorage", () => {
  function fakeTransport(): S3Transport & { store: Map<string, { body: string; etag: string }> } {
    const store = new Map<string, { body: string; etag: string }>();
    let etagCounter = 0;
    const transport: S3Transport & { store: typeof store } = {
      store,
      send: vi.fn(async (request) => {
        const key = `${request.bucket}/${request.key}`;
        if (request.method === "GET") {
          const entry = store.get(key);
          if (!entry) return { status: 404, headers: {}, body: "" };
          return { status: 200, headers: { etag: entry.etag }, body: entry.body };
        }
        // PUT
        const ifMatch = request.headers["if-match"];
        const ifNoneMatch = request.headers["if-none-match"];
        const existing = store.get(key);
        if (ifNoneMatch === "*" && existing) {
          return { status: 412, headers: {}, body: "" };
        }
        if (ifMatch !== undefined && existing?.etag !== ifMatch) {
          return { status: 412, headers: {}, body: "" };
        }
        etagCounter += 1;
        const etag = `"etag-${etagCounter}"`;
        store.set(key, { body: request.body ?? "", etag });
        return { status: 200, headers: { etag }, body: "" };
      }),
    };
    return transport;
  }

  it("returns null on load() when the object does not exist", async () => {
    const transport = fakeTransport();
    const storage = new ExperimentalS3IntentGraphStorage({
      bucket: "my-bucket",
      key: "intent-graph.json",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      transport,
    });
    await expect(storage.load()).resolves.toBeNull();
  });

  it("round-trips a saved graph through the fake transport", async () => {
    const transport = fakeTransport();
    const storage = new ExperimentalS3IntentGraphStorage({
      bucket: "my-bucket",
      key: "intent-graph.json",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      transport,
    });
    const { IntentGraph } = await import("./index.js");
    await storage.save(IntentGraph.fromJson(graphJson(7)));

    const other = new ExperimentalS3IntentGraphStorage({
      bucket: "my-bucket",
      key: "intent-graph.json",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      transport,
    });
    const loaded = await other.load();
    expect(loaded?.rev).toBe(7);
  });

  it("skips the PUT when rev is unchanged since the last save", async () => {
    const transport = fakeTransport();
    const storage = new ExperimentalS3IntentGraphStorage({
      bucket: "my-bucket",
      key: "intent-graph.json",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      transport,
    });
    const { IntentGraph } = await import("./index.js");
    const graph = IntentGraph.fromJson(graphJson(2));
    await storage.save(graph);
    const callsAfterFirstSave = (transport.send as ReturnType<typeof vi.fn>).mock.calls.length;

    await storage.save(graph);
    expect((transport.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsAfterFirstSave,
    );
  });

  it("raises StaleIntentGraphError on a conditional-write 412 (concurrent save)", async () => {
    const transport = fakeTransport();
    const options = {
      bucket: "my-bucket",
      key: "intent-graph.json",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      transport,
    };
    const { IntentGraph } = await import("./index.js");
    const writerA = new ExperimentalS3IntentGraphStorage(options);
    const writerB = new ExperimentalS3IntentGraphStorage(options);

    await writerA.save(IntentGraph.fromJson(graphJson(1)));
    await writerB.load(); // B observes rev 1 / the current etag

    await writerA.save(IntentGraph.fromJson(graphJson(2))); // A advances it first

    await expect(writerB.save(IntentGraph.fromJson(graphJson(2)))).rejects.toThrow(
      StaleIntentGraphError,
    );
  });

  it("surfaces the AWS error code and message on a load() failure", async () => {
    const transport: S3Transport = {
      send: vi.fn(async () => ({
        status: 403,
        headers: {},
        body:
          '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>SignatureDoesNotMatch</Code>' +
          "<Message>The request signature we calculated does not match the signature you provided.</Message>" +
          "</Error>",
      })),
    };
    const storage = new ExperimentalS3IntentGraphStorage({
      bucket: "my-bucket",
      key: "intent-graph.json",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      transport,
    });
    await expect(storage.load()).rejects.toThrow(
      /status 403 \(SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided\.\)/,
    );
  });

  it("surfaces the AWS error code and message on a save() failure", async () => {
    const transport: S3Transport = {
      send: vi.fn(async (request) =>
        request.method === "GET"
          ? { status: 404, headers: {}, body: "" }
          : {
              status: 403,
              headers: {},
              body:
                '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code>' +
                "<Message>Access Denied</Message></Error>",
            },
      ),
    };
    const storage = new ExperimentalS3IntentGraphStorage({
      bucket: "my-bucket",
      key: "intent-graph.json",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      transport,
    });
    const { IntentGraph } = await import("./index.js");
    await expect(storage.save(IntentGraph.fromJson(graphJson(1)))).rejects.toThrow(
      /status 403 \(AccessDenied: Access Denied\)/,
    );
  });

  it("falls back to a bare status when the error body has no AWS <Code>", async () => {
    const transport: S3Transport = {
      send: vi.fn(async () => ({ status: 500, headers: {}, body: "Internal Server Error" })),
    };
    const storage = new ExperimentalS3IntentGraphStorage({
      bucket: "my-bucket",
      key: "intent-graph.json",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      transport,
    });
    await expect(storage.load()).rejects.toThrow(/status 500$/);
  });
});
