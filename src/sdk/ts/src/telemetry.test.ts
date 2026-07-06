import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureTelemetry, type ExecutableTool, SkillCatalog, ToolCatalog } from "./index.js";
import { isModuleNotFound, recordAuthNeeded } from "./telemetry.js";

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
    catalog.register(readFile);
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
    catalog.register(readFile);
    await catalog.invoke("read_file", { path: "/secret" });

    const [span] = spansNamed("execute_tool read_file");
    expect(attrs(span)["gen_ai.tool.call.arguments"]).toBeUndefined();
    expect(attrs(span)["gen_ai.tool.call.result"]).toBeUndefined();
  });

  it("captures content when the ecosystem gate is set", async () => {
    process.env[CAPTURE_ENV] = "SPAN_AND_EVENT";
    const catalog = new ToolCatalog();
    catalog.register(readFile);
    await catalog.invoke("read_file", { path: "/p" });

    const [span] = spansNamed("execute_tool read_file");
    expect(attrs(span)["gen_ai.tool.call.arguments"]).toBe('{"path":"/p"}');
    expect(attrs(span)["gen_ai.tool.call.result"]).toContain("contents of /p");
  });

  it("keeps content off the span under EVENT_ONLY (content rides events, not spans)", async () => {
    process.env[CAPTURE_ENV] = "EVENT_ONLY";
    const catalog = new ToolCatalog();
    catalog.register(readFile);
    await catalog.invoke("read_file", { path: "/p" });

    const [span] = spansNamed("execute_tool read_file");
    expect(attrs(span)["gen_ai.tool.call.arguments"]).toBeUndefined();
    expect(attrs(span)["gen_ai.tool.call.result"]).toBeUndefined();
  });

  it("keeps content off the span under explicit NO_CONTENT", async () => {
    process.env[CAPTURE_ENV] = "NO_CONTENT";
    const catalog = new ToolCatalog();
    catalog.register(readFile);
    await catalog.invoke("read_file", { path: "/p" });

    const [span] = spansNamed("execute_tool read_file");
    expect(attrs(span)["gen_ai.tool.call.arguments"]).toBeUndefined();
    expect(attrs(span)["gen_ai.tool.call.result"]).toBeUndefined();
  });

  it("records args_size_bytes as UTF-8 bytes, not UTF-16 characters", async () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);
    // "café" is 4 UTF-16 chars but 5 UTF-8 bytes; the JSON wrapper adds ASCII bytes.
    await catalog.invoke("read_file", { path: "café" });

    const [span] = spansNamed("execute_tool read_file");
    const expected = new TextEncoder().encode(JSON.stringify({ path: "café" })).length;
    expect(attrs(span)["ratel.tool.args_size_bytes"]).toBe(expected);
  });

  it("tags an MCP-proxied invoke with ratel.upstream.server and omits it for a plain tool", async () => {
    const catalog = new ToolCatalog();
    catalog.register(gmailSend);
    catalog.register(readFile);
    await catalog.invoke("gmail__send_email", { to: "a@b.com" });
    await catalog.invoke("read_file", { path: "/x" });

    const [proxied] = spansNamed("execute_tool gmail__send_email");
    expect(attrs(proxied)["ratel.upstream.server"]).toBe("gmail");
    const [plain] = spansNamed("execute_tool read_file");
    expect(attrs(plain)["ratel.upstream.server"]).toBeUndefined();
  });

  it("marks the span ERROR and rethrows when the tool throws", async () => {
    const catalog = new ToolCatalog();
    catalog.register(boom);
    await expect(catalog.invoke("boom", {})).rejects.toThrow("kaboom");

    const [span] = spansNamed("execute_tool boom");
    expect(span.status.code).toBe(2); // ERROR
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("leaves the local trace stream intact alongside the span", async () => {
    const catalog = new ToolCatalog({ trace: { kind: "memory", sessionId: "s" } });
    catalog.register(readFile);
    await catalog.invoke("read_file", { path: "/tmp/x" });

    const local = catalog.drainTraceEvents() as Array<{ type: string }>;
    const invokeEvents = local.map((e) => e.type).filter((t) => t.startsWith("invoke_"));
    expect(invokeEvents).toEqual(["invoke_start", "invoke_end"]);
    expect(spansNamed("execute_tool read_file")).toHaveLength(1);
  });
});

describe("ratel.search span", () => {
  it("records target=tool with top_k, origin, and hit_count", () => {
    const catalog = new ToolCatalog();
    catalog.register(readFile);
    catalog.search("read file", 5, "agent");

    const [span] = spansNamed("ratel.search");
    expect(attrs(span)["ratel.search.target"]).toBe("tool");
    expect(attrs(span)["ratel.search.top_k"]).toBe(5);
    expect(attrs(span)["ratel.origin"]).toBe("agent");
    expect(attrs(span)["ratel.search.hit_count"]).toBeGreaterThan(0);
    expect(attrs(span)["ratel.search.query"]).toBeUndefined(); // content off by default
  });

  it("records target=skill for the skill catalog and captures the query when gated", () => {
    process.env[CAPTURE_ENV] = "SPAN_ONLY";
    const skills = new SkillCatalog();
    skills.register({
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
  it("wraps a skill load with the skill id", () => {
    const skills = new SkillCatalog();
    skills.register({
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
    catalog.register(readFile);

    expect(catalog.search("read", 5).length).toBeGreaterThan(0);
    await expect(catalog.invoke("read_file", { path: "/x" })).resolves.toEqual({
      contents: "contents of /x",
    });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
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

describe("isModuleNotFound (configureTelemetry import guard)", () => {
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
