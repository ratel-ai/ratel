import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ContentCapture,
  configureTelemetry,
  type ExecutableTool,
  SkillCatalog,
  setContentCapture,
  type TelemetryHandle,
  ToolCatalog,
} from "./index.js";
import { isModuleNotFound, isPeerInstalled, recordAuthNeeded } from "./telemetry.js";

/**
 * Instrumentation is verified through the public OTel API: register an in-memory
 * exporter as the global provider, drive the SDK, and read the spans back. The
 * SDK code never imports the exporter — it emits to whatever provider is active,
 * exactly as a host deployment would wire it.
 */
let exporter: InMemorySpanExporter;

const CAPTURE_ENV = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT";

beforeEach(() => {
  // Fresh exporter + provider each test. Don't shut the provider down in teardown
  // (that would also shut the exporter); just drop the global registration.
  exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
});

afterEach(() => {
  delete process.env[CAPTURE_ENV];
  setContentCapture(null); // never leak a programmatic capture override across tests
  trace.disable(); // reset the global provider to the no-op default
});

const readFile: ExecutableTool = {
  id: "read_file",
  name: "read_file",
  description: "Read a file from local disk and return its textual contents.",
  inputSchema: { properties: { path: { type: "string" } } },
  outputSchema: { properties: { contents: { type: "string" } } },
  execute: async ({ path }) => ({ contents: `contents of ${path}` }),
};

const boom: ExecutableTool = {
  id: "boom",
  name: "boom",
  description: "Always throws, to exercise the error path.",
  inputSchema: { properties: {} },
  outputSchema: { properties: {} },
  execute: async () => {
    throw new Error("kaboom");
  },
};

// An MCP-proxied tool: `<server>__<tool>` id convention.
const gmailSend: ExecutableTool = {
  id: "gmail__send_email",
  name: "send_email",
  description: "Send an email through the Gmail upstream.",
  inputSchema: { properties: { to: { type: "string" } } },
  outputSchema: { properties: {} },
  execute: async () => ({ ok: true }),
};

/** All exported spans with the given name. */
function spansNamed(name: string): ReadableSpan[] {
  return exporter.getFinishedSpans().filter((s) => s.name === name);
}

function attrs(span: ReadableSpan): Record<string, unknown> {
  return span.attributes as Record<string, unknown>;
}

describe("execute_tool span", () => {
  it("wraps a tool invocation with gen_ai + ratel attributes", async () => {
    const catalog = new ToolCatalog();
    await catalog.register(readFile);
    await catalog.invoke("read_file", { path: "/tmp/x" });

    const [span] = spansNamed("execute_tool read_file");
    expect(span, "one execute_tool span").toBeTruthy();
    expect(attrs(span)["gen_ai.operation.name"]).toBe("execute_tool");
    expect(attrs(span)["gen_ai.tool.name"]).toBe("read_file");
    expect(attrs(span)["ratel.tool.args_size_bytes"]).toBeGreaterThan(0);
    expect(span.status.code).toBe(1); // OK
  });

  it("does not capture argument/result content by default", async () => {
    const catalog = new ToolCatalog();
    await catalog.register(readFile);
    await catalog.invoke("read_file", { path: "/secret" });

    const [span] = spansNamed("execute_tool read_file");
    expect(attrs(span)["gen_ai.tool.call.arguments"]).toBeUndefined();
    expect(attrs(span)["gen_ai.tool.call.result"]).toBeUndefined();
  });

  it("captures content when the ecosystem gate is set", async () => {
    process.env[CAPTURE_ENV] = "SPAN_AND_EVENT";
    const catalog = new ToolCatalog();
    await catalog.register(readFile);
    await catalog.invoke("read_file", { path: "/p" });

    const [span] = spansNamed("execute_tool read_file");
    expect(attrs(span)["gen_ai.tool.call.arguments"]).toBe('{"path":"/p"}');
    expect(attrs(span)["gen_ai.tool.call.result"]).toContain("contents of /p");
  });

  it("keeps content off the span under EVENT_ONLY (content rides events, not spans)", async () => {
    process.env[CAPTURE_ENV] = "EVENT_ONLY";
    const catalog = new ToolCatalog();
    await catalog.register(readFile);
    await catalog.invoke("read_file", { path: "/p" });

    const [span] = spansNamed("execute_tool read_file");
    expect(attrs(span)["gen_ai.tool.call.arguments"]).toBeUndefined();
    expect(attrs(span)["gen_ai.tool.call.result"]).toBeUndefined();
  });

  it("keeps content off the span under explicit NO_CONTENT", async () => {
    process.env[CAPTURE_ENV] = "NO_CONTENT";
    const catalog = new ToolCatalog();
    await catalog.register(readFile);
    await catalog.invoke("read_file", { path: "/p" });

    const [span] = spansNamed("execute_tool read_file");
    expect(attrs(span)["gen_ai.tool.call.arguments"]).toBeUndefined();
    expect(attrs(span)["gen_ai.tool.call.result"]).toBeUndefined();
  });

  it("records args_size_bytes as UTF-8 bytes, not UTF-16 characters", async () => {
    const catalog = new ToolCatalog();
    await catalog.register(readFile);
    // "café" is 4 UTF-16 chars but 5 UTF-8 bytes; the JSON wrapper adds ASCII bytes.
    await catalog.invoke("read_file", { path: "café" });

    const [span] = spansNamed("execute_tool read_file");
    const expected = new TextEncoder().encode(JSON.stringify({ path: "café" })).length;
    expect(attrs(span)["ratel.tool.args_size_bytes"]).toBe(expected);
  });

  it("tags an MCP-proxied invoke with ratel.upstream.server and omits it for a plain tool", async () => {
    const catalog = new ToolCatalog();
    await catalog.register(gmailSend);
    await catalog.register(readFile);
    await catalog.invoke("gmail__send_email", { to: "a@b.com" });
    await catalog.invoke("read_file", { path: "/x" });

    const [proxied] = spansNamed("execute_tool gmail__send_email");
    expect(attrs(proxied)["ratel.upstream.server"]).toBe("gmail");
    const [plain] = spansNamed("execute_tool read_file");
    expect(attrs(plain)["ratel.upstream.server"]).toBeUndefined();
  });

  it("marks the span ERROR and rethrows when the tool throws", async () => {
    const catalog = new ToolCatalog();
    await catalog.register(boom);
    await expect(catalog.invoke("boom", {})).rejects.toThrow("kaboom");

    const [span] = spansNamed("execute_tool boom");
    expect(span.status.code).toBe(2); // ERROR
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("keeps an AsyncIterable span open until iteration completes", async () => {
    const catalog = new ToolCatalog();
    await catalog.register({
      ...readFile,
      id: "watch",
      execute: () =>
        (async function* () {
          yield { progress: 25 };
          yield { progress: 100 };
        })(),
    });

    const result = catalog.invokeRaw("watch", {});
    expect(spansNamed("execute_tool watch")).toHaveLength(0);

    const outputs: unknown[] = [];
    for await (const output of result as AsyncIterable<unknown>) outputs.push(output);

    expect(outputs).toEqual([{ progress: 25 }, { progress: 100 }]);
    const [span] = spansNamed("execute_tool watch");
    expect(span.status.code).toBe(1);
  });

  it("marks an AsyncIterable span ERROR when iteration throws", async () => {
    const catalog = new ToolCatalog();
    await catalog.register({
      ...readFile,
      id: "broken_watch",
      execute: () =>
        (async function* () {
          yield { progress: 25 };
          throw new Error("stream failed");
        })(),
    });

    const consume = async () => {
      for await (const _output of catalog.invokeRaw("broken_watch", {}) as AsyncIterable<unknown>) {
        // consume through the failure
      }
    };
    await expect(consume()).rejects.toThrow("stream failed");

    const [span] = spansNamed("execute_tool broken_watch");
    expect(span.status.code).toBe(2);
    expect(span.events.some((event) => event.name === "exception")).toBe(true);
  });

  it("ends the span as ERROR when AsyncIterable cancellation cleanup throws", async () => {
    const catalog = new ToolCatalog({ trace: { kind: "memory", sessionId: "s" } });
    await catalog.register({
      ...readFile,
      id: "broken_cleanup",
      execute: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ done: false as const, value: { progress: 25 } }),
            return: async () => {
              throw new Error("cleanup failed");
            },
          };
        },
      }),
    });
    catalog.drainTraceEvents();

    const consumeOne = async () => {
      for await (const _output of catalog.invokeRaw(
        "broken_cleanup",
        {},
      ) as AsyncIterable<unknown>) {
        break;
      }
    };
    await expect(consumeOne()).rejects.toThrow("cleanup failed");

    const [span] = spansNamed("execute_tool broken_cleanup");
    expect(span, "one completed execute_tool span").toBeTruthy();
    expect(span.status.code).toBe(2);
    expect(span.events.some((event) => event.name === "exception")).toBe(true);
    expect(
      (catalog.drainTraceEvents() as Array<{ type: string }>).map((event) => event.type),
    ).toEqual(["invoke_start", "invoke_error"]);
  });

  it("leaves the local trace stream intact alongside the span", async () => {
    const catalog = new ToolCatalog({ trace: { kind: "memory", sessionId: "s" } });
    await catalog.register(readFile);
    await catalog.invoke("read_file", { path: "/tmp/x" });

    const local = catalog.drainTraceEvents() as Array<{ type: string }>;
    const invokeEvents = local.map((e) => e.type).filter((t) => t.startsWith("invoke_"));
    expect(invokeEvents).toEqual(["invoke_start", "invoke_end"]);
    expect(spansNamed("execute_tool read_file")).toHaveLength(1);
  });
});

describe("ratel.search span", () => {
  it("records target=tool with top_k, origin, and hit_count", async () => {
    const catalog = new ToolCatalog();
    await catalog.register(readFile);
    catalog.search("read file", 5, "agent");

    const [span] = spansNamed("ratel.search");
    expect(attrs(span)["ratel.search.target"]).toBe("tool");
    expect(attrs(span)["ratel.search.top_k"]).toBe(5);
    expect(attrs(span)["ratel.origin"]).toBe("agent");
    expect(attrs(span)["ratel.search.hit_count"]).toBeGreaterThan(0);
    expect(attrs(span)["ratel.search.query"]).toBeUndefined(); // content off by default
  });

  it("records target=skill for the skill catalog and captures the query when gated", async () => {
    process.env[CAPTURE_ENV] = "SPAN_ONLY";
    const skills = new SkillCatalog();
    await skills.register({
      id: "pdf",
      name: "pdf",
      description: "fill pdf forms",
      tags: [],
      body: "b",
      tools: [],
    });
    skills.search("pdf", 3);

    const [span] = spansNamed("ratel.search");
    expect(attrs(span)["ratel.search.target"]).toBe("skill");
    expect(attrs(span)["ratel.search.query"]).toBe("pdf");
  });
});

describe("ratel.skill.load span", () => {
  it("wraps a skill load with the skill id", async () => {
    const skills = new SkillCatalog();
    await skills.register({
      id: "pdf",
      name: "pdf",
      description: "d",
      tags: [],
      body: "BODY",
      tools: [],
    });
    expect(skills.invoke("pdf")).toBe("BODY");

    const [span] = spansNamed("ratel.skill.load");
    expect(attrs(span)["ratel.skill.id"]).toBe("pdf");
    expect(span.status.code).toBe(1);
  });
});

describe("ratel.auth.flow span", () => {
  it("records outcome=needs_auth with the upstream server", () => {
    recordAuthNeeded("gmail");

    const [span] = spansNamed("ratel.auth.flow");
    expect(span, "one ratel.auth.flow span").toBeTruthy();
    expect(attrs(span)["ratel.auth.outcome"]).toBe("needs_auth");
    expect(attrs(span)["ratel.upstream.server"]).toBe("gmail");
  });

  it("omits the server attribute when the upstream is unknown", () => {
    recordAuthNeeded();

    const [span] = spansNamed("ratel.auth.flow");
    expect(attrs(span)["ratel.auth.outcome"]).toBe("needs_auth");
    expect(attrs(span)["ratel.upstream.server"]).toBeUndefined();
  });
});

describe("no provider configured", () => {
  it("is a no-op: operations still work and the wired exporter records nothing", async () => {
    // Drop the beforeEach provider; the OTel API now hands back non-recording spans.
    // `exporter` is that dropped provider's exporter, so if the SDK still reached it
    // (e.g. by caching a tracer) this would catch it.
    trace.disable();
    const catalog = new ToolCatalog();
    await catalog.register(readFile);

    expect(catalog.search("read", 5).length).toBeGreaterThan(0);
    await expect(catalog.invoke("read_file", { path: "/x" })).resolves.toEqual({
      contents: "contents of /x",
    });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe("span nesting", () => {
  // The attribute/status tests above register no ContextManager, so context.active()
  // is always ROOT and every span is rootless — parent/child linkage is invisible to
  // them. Register a real AsyncLocalStorageContextManager here so a regression that
  // swaps startActiveSpan for a non-active startSpan (which would detach nested spans)
  // is actually caught.
  it("parents an inner span to the wrapping execute_tool span", async () => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    try {
      const catalog = new ToolCatalog();
      await catalog.register(readFile);
      // Executor triggers a nested ratel.search while the outer execute_tool span is active.
      await catalog.register({
        id: "outer",
        name: "outer",
        description: "invokes a nested search",
        inputSchema: { properties: {} },
        outputSchema: { properties: {} },
        execute: async () => {
          catalog.search("read", 3);
          return { ok: true };
        },
      });
      await catalog.invoke("outer", {});

      const [outer] = spansNamed("execute_tool outer");
      const [inner] = spansNamed("ratel.search");
      expect(outer, "outer execute_tool span").toBeTruthy();
      expect(inner, "inner ratel.search span").toBeTruthy();
      expect(inner.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
      expect(inner.spanContext().traceId).toBe(outer.spanContext().traceId);
    } finally {
      context.disable(); // drop the context manager so other tests keep ROOT context
    }
  });

  it("keeps the execute_tool context active while an AsyncIterable advances", async () => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    try {
      const catalog = new ToolCatalog();
      await catalog.register(readFile);
      await catalog.register({
        id: "stream_outer",
        name: "stream_outer",
        description: "streams after a nested search",
        inputSchema: { properties: {} },
        outputSchema: { properties: {} },
        execute: () =>
          (async function* () {
            catalog.search("read", 3);
            yield { ok: true };
          })(),
      });

      for await (const _output of catalog.invokeRaw("stream_outer", {}) as AsyncIterable<unknown>) {
        // consume the stream under test
      }

      const [outer] = spansNamed("execute_tool stream_outer");
      const [inner] = spansNamed("ratel.search");
      expect(inner.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
      expect(inner.spanContext().traceId).toBe(outer.spanContext().traceId);
    } finally {
      context.disable();
    }
  });
});

describe("configureTelemetry", () => {
  it("loads the optional peer and delegates to its init()", async () => {
    // beforeEach already registered a global provider, so init()'s takeover guard
    // trips — which proves configureTelemetry resolved the optional @ratel-ai/telemetry-otlp
    // peer and called through to it (rather than throwing the install-guidance error).
    await expect(
      configureTelemetry({ endpoint: "http://localhost:4318/v1/traces" }),
    ).rejects.toThrow(/already registered/);
  });
});

describe("configureTelemetry content-capture options", () => {
  /**
   * Run configureTelemetry for real (init() must own the global provider, so the
   * beforeEach provider is dropped first), then swap the global back to a fresh
   * in-memory provider so the spans can be read. The capture override set by
   * configureTelemetry is module-level state in @ratel-ai/telemetry — not tied to
   * the provider — so it keeps applying to the in-memory spans.
   */
  async function configured(
    opts: Parameters<typeof configureTelemetry>[0],
  ): Promise<TelemetryHandle> {
    trace.disable();
    const handle = await configureTelemetry({
      endpoint: "http://localhost:4318/v1/traces",
      ...opts,
    });
    trace.disable();
    exporter = new InMemorySpanExporter();
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
    );
    return handle;
  }

  async function invokeAndReadArgs(): Promise<unknown> {
    const catalog = new ToolCatalog();
    await catalog.register(readFile);
    await catalog.invoke("read_file", { path: "/p" });
    const spans = spansNamed("execute_tool read_file");
    const [span] = spans.slice(-1); // most recent invoke
    return attrs(span)["gen_ai.tool.call.arguments"];
  }

  it("includeSpanAndEvents: true captures content with the env unset", async () => {
    const handle = await configured({ includeSpanAndEvents: true });
    try {
      expect(await invokeAndReadArgs()).toBe('{"path":"/p"}');
    } finally {
      await handle.shutdown();
    }
  });

  it("captureContent: SPAN_ONLY puts content on the span", async () => {
    const handle = await configured({ captureContent: "SPAN_ONLY" });
    try {
      expect(await invokeAndReadArgs()).toBe('{"path":"/p"}');
    } finally {
      await handle.shutdown();
    }
  });

  it("the option beats an explicitly set env (env SPAN_AND_EVENT + false -> no content)", async () => {
    process.env[CAPTURE_ENV] = "SPAN_AND_EVENT";
    const handle = await configured({ includeSpanAndEvents: false });
    try {
      expect(await invokeAndReadArgs()).toBeUndefined();
    } finally {
      await handle.shutdown();
    }
  });

  it("captureContent wins over includeSpanAndEvents", async () => {
    const handle = await configured({ captureContent: "NO_CONTENT", includeSpanAndEvents: true });
    try {
      expect(await invokeAndReadArgs()).toBeUndefined();
    } finally {
      await handle.shutdown();
    }
  });

  it("shutdown() restores env-driven behavior", async () => {
    const handle = await configured({ includeSpanAndEvents: true });
    await handle.shutdown();

    // Env unset again -> back to the NO_CONTENT default.
    expect(await invokeAndReadArgs()).toBeUndefined();

    // And the env var rules again once set.
    process.env[CAPTURE_ENV] = "SPAN_ONLY";
    expect(await invokeAndReadArgs()).toBe('{"path":"/p"}');
  });

  it("with neither option, the env keeps ruling", async () => {
    process.env[CAPTURE_ENV] = "SPAN_ONLY";
    const handle = await configured({});
    try {
      expect(await invokeAndReadArgs()).toBe('{"path":"/p"}');
    } finally {
      await handle.shutdown();
    }
  });

  it("a stale handle's shutdown does not clobber a newer override", async () => {
    // Privacy off in code while the env says full capture: a late h1.shutdown()
    // (SIGTERM hook, test teardown) must not clear h2's override — that would
    // silently re-enable content capture via the env fallback.
    process.env[CAPTURE_ENV] = "SPAN_AND_EVENT";
    const h1 = await configured({ includeSpanAndEvents: false });
    const h2 = await configured({ includeSpanAndEvents: false });

    await h1.shutdown(); // stale generation — must no-op on the override
    expect(await invokeAndReadArgs()).toBeUndefined(); // still h2's NO_CONTENT, not the env

    await h2.shutdown(); // current owner — env-driven again
    expect(await invokeAndReadArgs()).toBe('{"path":"/p"}');
  });

  it("accepts a lowercase captureContent (normalized like the env var)", async () => {
    const handle = await configured({ captureContent: "span_only" as ContentCapture });
    try {
      expect(await invokeAndReadArgs()).toBe('{"path":"/p"}');
    } finally {
      await handle.shutdown();
    }
  });

  it("throws a TypeError on garbage captureContent before any exporter side effects", async () => {
    trace.disable();
    await expect(
      configureTelemetry({
        endpoint: "http://localhost:4318/v1/traces",
        captureContent: "garbage" as ContentCapture,
      }),
    ).rejects.toThrow(TypeError);

    // No provider was registered by the failed call: this in-memory registration
    // takes (it would silently lose to a leaked init() provider, and the span
    // below would never reach `exporter`)...
    exporter = new InMemorySpanExporter();
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
    );
    // ...and no garbage override was stored: the env var still rules.
    process.env[CAPTURE_ENV] = "SPAN_ONLY";
    expect(await invokeAndReadArgs()).toBe('{"path":"/p"}');
    delete process.env[CAPTURE_ENV];
    expect(await invokeAndReadArgs()).toBeUndefined();
  });
});

describe("isPeerInstalled (configureTelemetry install probe)", () => {
  it("detects an installed package and an absent one without executing them", () => {
    // The optional peer is a workspace dep, so it resolves; a nonsense name does not.
    // This is the crux of the transitive-dep fix: a *present* peer must read as
    // installed so a later load error surfaces instead of being masked as "not installed".
    expect(isPeerInstalled("@ratel-ai/telemetry-otlp")).toBe(true);
    expect(isPeerInstalled("@ratel-ai/definitely-not-a-real-package")).toBe(false);
  });
});

describe("isModuleNotFound (install-probe error classifier)", () => {
  it("is true only for a genuine module-not-found code", () => {
    expect(isModuleNotFound(Object.assign(new Error("x"), { code: "ERR_MODULE_NOT_FOUND" }))).toBe(
      true,
    );
    expect(isModuleNotFound(Object.assign(new Error("x"), { code: "MODULE_NOT_FOUND" }))).toBe(
      true,
    );
  });

  it("is false for a package that throws while loading, so the real error is rethrown", () => {
    expect(isModuleNotFound(Object.assign(new Error("boom"), { code: "ERR_DLOPEN_FAILED" }))).toBe(
      false,
    );
    expect(isModuleNotFound(new Error("plain error, no code"))).toBe(false);
    expect(isModuleNotFound(undefined)).toBe(false);
  });
});
