import { SEARCH_CAPABILITIES_ID, type SearchCapabilitiesResult } from "@ratel-ai/sdk";
import { type Tool, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { aiSdk } from "./aisdk.js";

// A JSON Schema whose `properties` we read positionally in assertions.
type JsonObjectSchema = { type?: string; properties?: Record<string, { type?: string }> };

describe("aiSdk() identity", () => {
  it('names itself "ai-sdk" — matches the core KNOWN_FRAMEWORKS table', () => {
    expect(aiSdk().name).toBe("ai-sdk");
  });
});

describe("ingest codec", () => {
  it("passes through a provider-executed tool (no execute)", () => {
    const providerTool = tool({
      description: "provider-run search",
      inputSchema: z.object({ q: z.string() }),
    });
    expect(aiSdk().ingest("provider_search", providerTool)).toBe("passthrough");
  });

  it("ingests an executable: resolves description, converts input schema, omits output schema", () => {
    const weather = tool({
      description: "Get the weather in a location",
      inputSchema: z.object({ location: z.string() }),
      execute: async ({ location }) => ({ location, tempF: 70 }),
    });
    const reg = aiSdk().ingest("weather", weather);
    if (reg === "passthrough") throw new Error("expected an executable registration");
    expect(reg.description).toBe("Get the weather in a location");
    const input = reg.inputSchema as JsonObjectSchema;
    expect(input.type).toBe("object");
    expect(input.properties?.location.type).toBe("string");
    // Absent output schema stays absent — the core defaults it, the adapter never does.
    expect(reg.outputSchema).toBeUndefined();
  });

  it("converts the output schema when the framework tool declares one", () => {
    const t = tool({
      description: "structured",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: true }),
    });
    const reg = aiSdk().ingest("structured", t);
    if (reg === "passthrough") throw new Error("expected an executable registration");
    const output = reg.outputSchema as JsonObjectSchema;
    expect(output.type).toBe("object");
    expect(output.properties?.ok.type).toBe("boolean");
  });

  it("resolves a dynamic description once at ingest time, with a null tool context", () => {
    let calls = 0;
    let seenContext: unknown = "unset";
    const t = tool({
      // ai lets a tool description be a function of the live tool context; recall
      // ranks at ingest time, so resolve it now with a fabricated null context.
      description: ((opts: { context: unknown }) => {
        calls++;
        seenContext = opts.context;
        return "dynamic description";
      }) as unknown as string,
      inputSchema: z.object({}),
      execute: async () => ({}),
    });
    const reg = aiSdk().ingest("dyn", t);
    if (reg === "passthrough") throw new Error("expected an executable registration");
    expect(reg.description).toBe("dynamic description");
    expect(calls).toBe(1);
    expect(seenContext).toBeUndefined();
  });

  it("fabricates AI SDK execution options (incl. a context field) when the catalog runs the tool", async () => {
    let seenOptions: Record<string, unknown> | undefined;
    const t = tool({
      description: "spy",
      inputSchema: z.object({}),
      execute: ((_input: unknown, options: Record<string, unknown>) => {
        seenOptions = options;
        return { ran: true };
      }) as unknown as Tool["execute"],
    });
    const reg = aiSdk().ingest("spy", t);
    if (reg === "passthrough") throw new Error("expected an executable registration");
    const out = await reg.execute({});
    expect(out).toEqual({ ran: true });
    // ai@7 tool executors may read options.context — fabricate it so a reader
    // sees a fake rather than a crash on a missing field.
    expect(seenOptions && "context" in seenOptions).toBe(true);
    expect(seenOptions?.toolCallId).toBe("ratel_spy");
    expect(seenOptions?.messages).toEqual([]);
  });
});

describe("expose codec", () => {
  it("wraps a Ratel capability tool as a framework tool, framework-shaped (no id/outputSchema)", async () => {
    const capability = {
      id: "cap",
      name: "cap",
      description: "a capability tool",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      outputSchema: { type: "object" },
      execute: async (args: unknown) => ({ echoed: args }),
    };
    const exposed = aiSdk().expose(capability) as Tool & { id?: unknown; outputSchema?: unknown };
    expect(exposed.description).toBe("a capability tool");
    expect("id" in exposed).toBe(false);
    expect("outputSchema" in exposed).toBe(false);
    // Execution delegates to the capability's own executor.
    const run = exposed.execute as (args: unknown, opts: unknown) => Promise<unknown>;
    expect(await run({ q: "hi" }, {})).toEqual({ echoed: { q: "hi" } });
  });
});

describe("recallMessages codec", () => {
  it("renders the synthetic search_capabilities call/result pair in ModelMessage shape", () => {
    const recall = {
      tools: { groups: [{ server: { name: "fs" }, hits: [{ toolId: "read_file", score: 1 }] }] },
      skills: [],
    } as unknown as SearchCapabilitiesResult;
    const [call, result] = aiSdk().recallMessages(
      { callId: "recall_0", query: "read a file" },
      recall,
    );

    expect(call.role).toBe("assistant");
    const callPart = (call.content as Array<Record<string, unknown>>)[0];
    expect(callPart.type).toBe("tool-call");
    expect(callPart.toolCallId).toBe("recall_0");
    expect(callPart.toolName).toBe(SEARCH_CAPABILITIES_ID);
    expect(callPart.input).toEqual({ query: "read a file" });

    expect(result.role).toBe("tool");
    const resultPart = (result.content as Array<Record<string, unknown>>)[0];
    expect(resultPart.type).toBe("tool-result");
    expect(resultPart.toolCallId).toBe("recall_0");
    expect(resultPart.toolName).toBe(SEARCH_CAPABILITIES_ID);
    // The result is carried as a JSON text part the model reads back.
    expect(resultPart.output).toEqual({ type: "text", value: JSON.stringify(recall) });
  });
});
