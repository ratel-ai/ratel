import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ExecutableTool, SkillCatalog, ToolCatalog } from "./index.js";

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

describe("no provider configured", () => {
  it("is a no-op: operations still work and nothing is exported", async () => {
    trace.disable(); // drop back to the default non-recording provider
    const local = new InMemorySpanExporter();
    const catalog = new ToolCatalog();
    catalog.register(readFile);

    expect(catalog.search("read", 5).length).toBeGreaterThan(0);
    await expect(catalog.invoke("read_file", { path: "/x" })).resolves.toEqual({
      contents: "contents of /x",
    });
    expect(local.getFinishedSpans()).toHaveLength(0);
  });
});
