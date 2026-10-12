import type { Attributes } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { experimentalToolSequenceSpanProcessor, IntentGraph, ToolCatalog } from "./index.js";

const tool = (id: string) => ({
  id,
  name: id,
  description: id.replace(/_/g, " "),
  inputSchema: {},
  outputSchema: {},
  execute: async () => id,
});

async function setup() {
  const catalog = new ToolCatalog();
  await catalog.register(["find_task", "assign_task"].map(tool));
  const graph = new IntentGraph();
  catalog.experimentalEnableAdaptiveRanking(graph);
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [
      experimentalToolSequenceSpanProcessor(catalog),
      new SimpleSpanProcessor(exporter),
    ],
  });
  /** A host framework's tool span, as the AI SDK starts it. */
  const runTool = (name: string, scope = "gen_ai", status?: { code: 2 }) => {
    const attributes: Attributes = {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": name,
    };
    const span = provider.getTracer(scope).startSpan(`execute_tool ${name}`, { attributes });
    if (status) span.setStatus(status);
    span.end();
  };
  const transitions = () => JSON.parse(graph.toJson()).transitions ?? {};
  return { catalog, exporter, runTool, transitions };
}

describe("experimentalToolSequenceSpanProcessor", () => {
  it("learns the order of host tool spans inside a turn", async () => {
    const { catalog, runTool, transitions } = await setup();
    catalog.turn(() => {
      runTool("find_task");
      runTool("assign_task");
    });
    const t = transitions();
    expect(t["<start>"].next).toEqual({ find_task: 1 });
    expect(t.find_task.next).toEqual({ assign_task: 1 });
  });

  it("counts a failed tool as the choice it was", async () => {
    const { catalog, runTool, transitions } = await setup();
    catalog.turn(() => runTool("find_task", "gen_ai", { code: 2 }));
    expect(transitions()["<start>"].next).toEqual({ find_task: 1 });
  });

  it("ignores spans outside a turn, Ratel's own spans, and gateway tools", async () => {
    const { catalog, runTool, transitions } = await setup();
    runTool("find_task");
    catalog.turn(() => {
      runTool("find_task", "@ratel-ai/sdk");
      runTool("invoke_tool");
      runTool("search_capabilities");
      runTool("get_skill_content");
    });
    expect(transitions()).toEqual({});
  });

  it("never changes a span", async () => {
    const { catalog, exporter, runTool } = await setup();
    catalog.turn(() => runTool("find_task"));
    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes).toEqual({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "find_task",
    });
  });
});
