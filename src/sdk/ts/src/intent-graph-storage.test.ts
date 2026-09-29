import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { renameControl } = vi.hoisted(() => ({ renameControl: { failNext: false } }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (renameControl.failNext) {
        renameControl.failNext = false;
        throw new Error("injected rename failure");
      }
      return actual.rename(from, to);
    },
  };
});

import { IntentGraph, ToolCatalog } from "./index.js";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  LocalFileIntentGraphStorage,
  S3IntentGraphStorage,
  type S3Transport,
  StaleIntentGraphError,
} from "./intent-graph-storage.js";
import { awsUriEncode, resolveS3Endpoint, signS3Request } from "./sigv4.js";

const V1_EMPTY_GRAPH = { v: 1, built_from_ts: 0, rev: 0, intents: [] };

function graphJson(rev: number): string {
  return JSON.stringify({ ...V1_EMPTY_GRAPH, rev });
}

/** A catalog that learns, so `rev` moves through the real observation path. */
async function learningCatalog(): Promise<ToolCatalog> {
  const catalog = new ToolCatalog({});
  await catalog.register([
    {
      id: "gh_run_list",
      name: "gh_run_list",
      description: "List CI workflow runs and whether the build passed",
      inputSchema: {},
      outputSchema: {},
      execute: async () => "listed",
    },
    {
      id: "docker_build",
      name: "docker_build",
      description: "Build a Docker image from a Dockerfile",
      inputSchema: {},
      outputSchema: {},
      execute: async () => "built",
    },
  ]);
  return catalog;
}

/** One confirmed observation: search, then invoke what you wanted. Bumps `rev`. */
async function useIt(catalog: ToolCatalog, query: string, chosen: string): Promise<void> {
  catalog.search(query, 5);
  await catalog.invoke(chosen, {});
}

describe("LocalFileIntentGraphStorage", () => {
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
    const storage = new LocalFileIntentGraphStorage({ path: await tempPath() });
    await expect(storage.load()).resolves.toBeNull();
  });

  it("round-trips a saved graph, preserving rev", async () => {
    const path = await tempPath();
    const storage = new LocalFileIntentGraphStorage({ path });
    const graph = (await import("./index.js")).IntentGraph.fromJson(graphJson(3));
    await storage.save(graph);

    const other = new LocalFileIntentGraphStorage({ path });
    const loaded = await other.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.rev).toBe(3);
  });

  it("round-trips the learned clusters, not just the rev", async () => {
    // Every other fixture here is an empty graph, so a save() that kept only
    // the rev counter and discarded every cluster would pass the whole suite.
    const catalog = await learningCatalog();
    const graph = new IntentGraph();
    catalog.experimentalEnableAdaptiveRanking(graph);
    await useIt(catalog, "why is the build broken", "gh_run_list");
    await useIt(catalog, "is the build broken again", "gh_run_list");

    const before = JSON.parse(graph.toJson());
    expect(before.intents.length).toBeGreaterThan(0);
    expect(before.intents[0].members.length).toBeGreaterThan(0);
    expect(Object.keys(before.intents[0].tools).length).toBeGreaterThan(0);

    const path = await tempPath();
    await new LocalFileIntentGraphStorage({ path }).save(graph);
    const reloaded = await new LocalFileIntentGraphStorage({ path }).load();
    expect(reloaded).not.toBeNull();
    expect(JSON.parse(reloaded?.toJson() ?? "{}")).toEqual(before);
  });

  it("writes atomically via a temp file + rename", async () => {
    const path = await tempPath();
    const storage = new LocalFileIntentGraphStorage({ path });
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
    const storage = new LocalFileIntentGraphStorage({ path });
    const { IntentGraph } = await import("./index.js");
    const graph = IntentGraph.fromJson(graphJson(5));
    await storage.save(graph);
    const firstMtime = (await import("node:fs/promises").then((m) => m.stat(path))).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await storage.save(graph);
    const secondMtime = (await import("node:fs/promises").then((m) => m.stat(path))).mtimeMs;
    expect(secondMtime).toBe(firstMtime);
  });

  it("writes the graph 0600, and tightens a file an older build left readable", async () => {
    // The graph carries raw user query text, so the file is not world-readable.
    const path = await tempPath();
    const { IntentGraph } = await import("./index.js");

    const storage = new LocalFileIntentGraphStorage({ path });
    await storage.save(IntentGraph.fromJson(graphJson(1)));
    expect(stat(path).then((s) => s.mode & 0o777)).resolves.toBe(0o600);

    // A file an older build wrote 0644 is tightened by the next save, because
    // the mode lands on the temp file that the rename puts in its place.
    await chmod(path, 0o644);
    await storage.load();
    await storage.save(IntentGraph.fromJson(graphJson(2)));
    expect(stat(path).then((s) => s.mode & 0o777)).resolves.toBe(0o600);
  });

  it("removes the temp file when the rename fails", async () => {
    // Nothing in the fs API fails a rename while letting the write succeed, so
    // the failure is injected: what matters is that the temp file the write
    // already created does not survive the throw.
    const path = await tempPath();
    const { IntentGraph } = await import("./index.js");
    const storage = new LocalFileIntentGraphStorage({ path });

    renameControl.failNext = true;
    await expect(storage.save(IntentGraph.fromJson(graphJson(1)))).rejects.toThrow("injected");

    const entries = await readdir(join(path, ".."));
    expect(entries.filter((entry) => entry.startsWith(".tmp-"))).toEqual([]);
  });

  it("raises StaleIntentGraphError when the on-disk rev moved since load()", async () => {
    const path = await tempPath();
    const { IntentGraph } = await import("./index.js");
    const writer1 = new LocalFileIntentGraphStorage({ path });
    await writer1.save(IntentGraph.fromJson(graphJson(1)));

    const reader = new LocalFileIntentGraphStorage({ path });
    const loaded = await reader.load();
    expect(loaded?.rev).toBe(1);

    // Someone else loads the current graph and advances it on disk.
    const writer2 = new LocalFileIntentGraphStorage({ path });
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
    const writer1 = new LocalFileIntentGraphStorage({ path });
    await writer1.save(IntentGraph.fromJson(graphJson(1)));

    const blindWriter = new LocalFileIntentGraphStorage({ path });
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

  it("matches the signature AWS publishes for this request", () => {
    // The fixture above is AWS's `GET Object` example verbatim. Independently
    // confirmed against botocore 1.43.101, AWS's own implementation, signing
    // the same request at the same timestamp. Without this the suite passes
    // with a broken canonical request: dropping the empty query-string line,
    // swapping path and method, or hashing with SHA-1 all stay green.
    expect(signS3Request(baseRequest).headers.authorization).toContain(
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

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

  it("accepts a mixed-case header key and signs it lowercased", () => {
    // The canonical form is lowercase; indexing the caller's bag with a
    // lowercased name used to throw on `.trim()` of undefined.
    const signed = signS3Request({ ...baseRequest, headers: { "If-Match": '"etag-1"' } });
    expect(signed.headers.authorization).toContain("SignedHeaders=host;if-match;");
    expect(signed.headers["if-match"]).toBe('"etag-1"');
  });

  it("hashes an empty body to the well-known SHA-256 empty-string digest", () => {
    const signed = signS3Request(baseRequest);
    expect(signed.headers["x-amz-content-sha256"]).toBe(
      createHash("sha256").update("").digest("hex"),
    );
  });
});

describe("awsUriEncode", () => {
  it("leaves unreserved characters (A-Za-z0-9-._~) unescaped", () => {
    const unreserved = "AZaz09-._~";
    expect(awsUriEncode(unreserved)).toBe(unreserved);
  });

  it("percent-encodes sub-delim characters JS's encodeURIComponent leaves alone", () => {
    // https://docs.aws.amazon.com/general/latest/gr/create-signed-request.html —
    // UriEncode escapes every byte except unreserved characters; encodeURIComponent
    // alone under-escapes !*'() (matches Python's urllib.parse.quote(part, safe="")).
    expect(awsUriEncode("!*'()")).toBe("%21%2A%27%28%29");
  });

  it("percent-encodes a space as %20, not +", () => {
    expect(awsUriEncode("a b")).toBe("a%20b");
  });
});

describe("resolveS3Endpoint", () => {
  it("defaults to AWS virtual-hosted-style when no endpoint is given", () => {
    const target = resolveS3Endpoint({
      bucket: "my-bucket",
      key: "intent-graph.json",
      region: "eu-central-1",
    });
    expect(target).toEqual({
      scheme: "https",
      host: "my-bucket.s3.eu-central-1.amazonaws.com",
      path: "/intent-graph.json",
    });
  });

  it("defaults to path-style once a custom endpoint is set (MinIO etc.)", () => {
    const target = resolveS3Endpoint({
      bucket: "my-bucket",
      key: "intent-graph.json",
      region: "us-east-1",
      endpoint: "http://localhost:9000",
    });
    expect(target).toEqual({
      scheme: "http",
      host: "localhost:9000",
      path: "/my-bucket/intent-graph.json",
    });
  });

  it("honors forcePathStyle: false for a custom endpoint that supports virtual-hosted style", () => {
    const target = resolveS3Endpoint({
      bucket: "my-bucket",
      key: "intent-graph.json",
      region: "auto",
      endpoint: "https://minio.internal:9000",
      forcePathStyle: false,
    });
    expect(target).toEqual({
      scheme: "https",
      host: "my-bucket.minio.internal:9000",
      path: "/intent-graph.json",
    });
  });

  it("preserves a non-default port in the host", () => {
    const target = resolveS3Endpoint({
      bucket: "b",
      key: "k",
      region: "us-east-1",
      endpoint: "https://minio.internal:9000",
    });
    expect(target.host).toBe("minio.internal:9000");
  });

  it("percent-encodes special characters in the key under path-style, bucket included", () => {
    const target = resolveS3Endpoint({
      bucket: "my-bucket",
      key: "a!b*c'd(e)f",
      region: "us-east-1",
      endpoint: "http://localhost:9000",
    });
    expect(target.path).toBe("/my-bucket/a%21b%2Ac%27d%28e%29f");
  });

  it("rejects an endpoint that is not an absolute http(s) URL", () => {
    // `new URL("minio.internal:9000")` reads the host as a scheme and leaves
    // the host empty, which would send the signed request, credentials and all,
    // to whatever the bucket name resolves to.
    for (const endpoint of ["minio.internal:9000", "localhost:9000", "not a url", "ftp://h:21"]) {
      expect(() =>
        resolveS3Endpoint({ bucket: "b", key: "k", region: "us-east-1", endpoint }),
      ).toThrow(/expected an absolute http\(s\) URL/);
    }
  });

  it("keeps a path prefix, so a gateway under a mount point is addressed correctly", () => {
    expect(
      resolveS3Endpoint({
        bucket: "b",
        key: "k",
        region: "us-east-1",
        endpoint: "http://minio:9000/s3api",
      }).path,
    ).toBe("/s3api/b/k");
    // a bare endpoint keeps the pathname "/" from turning into a double slash
    expect(
      resolveS3Endpoint({
        bucket: "b",
        key: "k",
        region: "us-east-1",
        endpoint: "http://minio:9000/",
      }).path,
    ).toBe("/b/k");
  });

  it("drops userinfo and a default port from the signed host", () => {
    const host = (endpoint: string) =>
      resolveS3Endpoint({ bucket: "b", key: "k", region: "us-east-1", endpoint }).host;
    expect(host("http://user:pw@minio:9000")).toBe("minio:9000");
    expect(host("https://minio:443")).toBe("minio");
    expect(host("http://[::1]:9000")).toBe("[::1]:9000");
  });
});

describe("S3IntentGraphStorage", () => {
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
    const storage = new S3IntentGraphStorage({
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
    const storage = new S3IntentGraphStorage({
      bucket: "my-bucket",
      key: "intent-graph.json",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      transport,
    });
    const { IntentGraph } = await import("./index.js");
    await storage.save(IntentGraph.fromJson(graphJson(7)));

    const other = new S3IntentGraphStorage({
      bucket: "my-bucket",
      key: "intent-graph.json",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      transport,
    });
    const loaded = await other.load();
    expect(loaded?.rev).toBe(7);
  });

  it("round-trips the learned clusters through S3, not just the rev", async () => {
    const catalog = await learningCatalog();
    const graph = new IntentGraph();
    catalog.experimentalEnableAdaptiveRanking(graph);
    await useIt(catalog, "why is the build broken", "gh_run_list");
    const before = JSON.parse(graph.toJson());
    expect(before.intents[0].members.length).toBeGreaterThan(0);

    const transport = fakeTransport();
    const options = {
      bucket: "my-bucket",
      key: "intent-graph.json",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      transport,
    };
    await new S3IntentGraphStorage(options).save(graph);
    const reloaded = await new S3IntentGraphStorage(options).load();
    expect(JSON.parse(reloaded?.toJson() ?? "{}")).toEqual(before);
  });

  it("refuses a blind first save over an object that already exists", async () => {
    // ADR-0025 promises this guard for S3, and the local backend has it tested.
    // Without a test no PUT ever carries `if-none-match: *` against a populated
    // store, so the branch never executes.
    const transport = fakeTransport();
    const options = {
      bucket: "my-bucket",
      key: "intent-graph.json",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      transport,
    };
    const { IntentGraph: IG } = await import("./index.js");
    await new S3IntentGraphStorage(options).save(IG.fromJson(graphJson(1)));

    const blind = new S3IntentGraphStorage(options); // never load()ed
    await expect(blind.save(IG.fromJson(graphJson(2)))).rejects.toThrow(StaleIntentGraphError);
  });

  it("skips the PUT when rev is unchanged since the last save", async () => {
    const transport = fakeTransport();
    const storage = new S3IntentGraphStorage({
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

  it("persists a turn that lands while a save is in flight", async () => {
    // `rev` must be read out of the bytes being written, not from the graph
    // after the await: the graph keeps learning during the save, and recording
    // the newer rev against older content makes the next save skip that turn
    // for good (save-when-changed sees no change). Same shape guards the local
    // file backend and both Python mirrors.
    const catalog = await learningCatalog();
    const graph = new IntentGraph();
    catalog.experimentalEnableAdaptiveRanking(graph);

    let stored = "";
    let etagCounter = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holdPut = false;

    const transport: S3Transport = {
      async send(request) {
        if (request.method === "GET") {
          return stored
            ? { status: 200, headers: { etag: `"etag-${etagCounter}"` }, body: stored }
            : { status: 404, headers: {}, body: "" };
        }
        if (holdPut) await held;
        stored = request.body ?? "";
        etagCounter += 1;
        return { status: 200, headers: { etag: `"etag-${etagCounter}"` }, body: "" };
      },
    };
    const storage = new S3IntentGraphStorage({
      bucket: "my-bucket",
      key: "intent-graph.json",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      transport,
    });

    await useIt(catalog, "why is the build broken", "gh_run_list");
    await storage.save(graph);

    await useIt(catalog, "is the build broken again", "gh_run_list");
    holdPut = true;
    const inFlight = storage.save(graph);
    await useIt(catalog, "build broken on main", "gh_run_list"); // lands mid-save
    release();
    await inFlight;

    holdPut = false;
    await storage.save(graph);

    expect(JSON.parse(stored).rev).toBe(graph.rev);
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
    const writerA = new S3IntentGraphStorage(options);
    const writerB = new S3IntentGraphStorage(options);

    await writerA.save(IntentGraph.fromJson(graphJson(1)));
    await writerB.load(); // B observes rev 1 / the current etag

    await writerA.save(IntentGraph.fromJson(graphJson(2))); // A advances it first

    await expect(writerB.save(IntentGraph.fromJson(graphJson(2)))).rejects.toThrow(
      StaleIntentGraphError,
    );
  });

  it("labels the stored object application/json, and signs that header", async () => {
    const transport = fakeTransport();
    const storage = new S3IntentGraphStorage({
      bucket: "my-bucket",
      key: "intent-graph.json",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      transport,
    });
    const { IntentGraph } = await import("./index.js");
    await storage.save(IntentGraph.fromJson(graphJson(1)));

    const put = (transport.send as ReturnType<typeof vi.fn>).mock.calls
      .map(([request]) => request as { method: string; headers: Record<string, string> })
      .find((request) => request.method === "PUT");
    expect(put?.headers["content-type"]).toBe("application/json");
    // AWS requires a Content-Type that is present to be part of the signature.
    expect(
      signS3Request({
        method: "PUT",
        host: "my-bucket.s3.us-east-1.amazonaws.com",
        path: "/intent-graph.json",
        headers: put?.headers ?? {},
        body: "{}",
        region: "us-east-1",
        accessKeyId: "AKIA",
        secretAccessKey: "secret",
      }).headers.authorization,
    ).toContain("SignedHeaders=content-type;");
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
    const storage = new S3IntentGraphStorage({
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
    const storage = new S3IntentGraphStorage({
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
    const storage = new S3IntentGraphStorage({
      bucket: "my-bucket",
      key: "intent-graph.json",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      transport,
    });
    await expect(storage.load()).rejects.toThrow(/status 500$/);
  });
});

describe("S3IntentGraphStorage idle timeout", () => {
  const servers: import("node:net").Server[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  /** Listen on a loopback port, handing each raw socket to `onConnection`. */
  async function serve(onConnection: (socket: import("node:net").Socket) => void): Promise<string> {
    const { createServer } = await import("node:net");
    const server = createServer(onConnection);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    return `http://127.0.0.1:${address.port}`;
  }

  const storageAt = (endpoint: string, idleTimeoutMs: number) =>
    new S3IntentGraphStorage({
      bucket: "b",
      key: "k",
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      endpoint,
      idleTimeoutMs,
    });

  it("gives up on an endpoint that accepts and then says nothing", async () => {
    const endpoint = await serve(() => {
      /* accept, never reply */
    });
    const started = Date.now();
    await expect(storageAt(endpoint, 200).load()).rejects.toThrow(/no data for 200ms/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("lets a slow but steady response finish, past the timeout", async () => {
    // The distinguishing case: total time far exceeds the timeout, but no
    // single gap does. A deadline (AbortSignal.timeout) would kill this; an
    // idle clock must not.
    const graph = JSON.stringify({ v: 1, built_from_ts: 0, rev: 7, intents: [] });
    const endpoint = await serve((socket) => {
      socket.write(
        `HTTP/1.1 200 OK\r\nETag: "e1"\r\nContent-Length: ${graph.length}\r\n` +
          `Connection: close\r\n\r\n`,
      );
      let sent = 0;
      const dribble = setInterval(() => {
        if (sent >= graph.length) {
          clearInterval(dribble);
          socket.end();
          return;
        }
        socket.write(graph.slice(sent, sent + 4));
        sent += 4;
      }, 25);
    });

    const started = Date.now();
    const loaded = await storageAt(endpoint, 200).load();
    const elapsed = Date.now() - started;
    expect(loaded?.rev).toBe(7);
    expect(elapsed).toBeGreaterThan(200); // outlived the timeout while streaming
  });

  it("defaults to botocore's 60s", () => {
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(60_000);
  });
});
