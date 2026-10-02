import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import {
  currentTurnId,
  type ExecutableTool,
  INVOKE_TOOL_ID,
  IntentGraph,
  type Ratel,
  type RuntimeEvent,
  ratel,
  SEARCH_CAPABILITIES_ID,
  ToolCatalog,
  TURN_USER_MESSAGE_MAX_BYTES,
} from "./index.js";

function tool(id: string, description: string, execute = async () => "ok"): ExecutableTool {
  return { id, name: id, description, inputSchema: {}, outputSchema: {}, execute };
}

async function runtimeWithTools(): Promise<Ratel> {
  const r = ratel();
  await r.tools.register(
    tool("deploy_app", "deploy the app to production servers"),
    tool("read_logs", "read the application logs"),
  );
  return r;
}

/** Subscribe, run `work`, flush, and return everything delivered. */
async function capture(r: Ratel, work: () => Promise<void> | void): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  const subscription = r.events.subscribe((batch) => {
    events.push(...batch);
  });
  await work();
  await subscription.flush();
  subscription.unsubscribe();
  return events;
}

const ofType = (events: RuntimeEvent[], type: string) => events.filter((e) => e.type === type);
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("turn scope", () => {
  afterEach(() => {
    trace.disable();
    context.disable();
  });

  it("stamps the turn id and end-user id on everything inside and opens it with one turn_start", async () => {
    const r = await runtimeWithTools();
    let seenInside: string | undefined;
    const events = await capture(r, () =>
      r.turn(
        async () => {
          seenInside = r.currentTurnId();
          r.tools.search("deploy the app", 3);
          await tick();
          await r.tools.invoke("deploy_app", {});
        },
        { id: "req-1", userMessage: "please deploy", endUserId: "user-7" },
      ),
    );

    expect(seenInside).toBe("req-1");
    expect(r.currentTurnId()).toBeUndefined();
    const [start, ...extraStarts] = ofType(events, "turn_start");
    expect(extraStarts).toEqual([]);
    expect(start).toMatchObject({
      type: "turn_start",
      turn_id: "req-1",
      user_message: "please deploy",
      end_user_id: "user-7",
    });
    for (const type of ["search", "invoke_start", "invoke_end"]) {
      expect(ofType(events, type)).toEqual([
        expect.objectContaining({ turn_id: "req-1", end_user_id: "user-7" }),
      ]);
    }
    expect(events.findIndex((e) => e.type === "turn_start")).toBeLessThan(
      events.findIndex((e) => e.type === "search"),
    );
  });

  it("returns fn's result and mints an id when none is given", async () => {
    const r = await runtimeWithTools();
    let minted: string | undefined;
    const events = await capture(r, async () => {
      const value = await r.turn(async () => {
        minted = currentTurnId();
        return 42;
      });
      expect(value).toBe(42);
    });

    expect(minted).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const [start] = ofType(events, "turn_start");
    expect(start?.turn_id).toBe(minted);
    expect(start).not.toHaveProperty("user_message");
    expect(start).not.toHaveProperty("end_user_id");
  });

  it("keeps two interleaved async turns apart", async () => {
    const r = await runtimeWithTools();
    const events = await capture(r, async () => {
      const run = (id: string, query: string, toolId: string) =>
        r.turn(
          async () => {
            await tick();
            r.tools.search(query, 3);
            await tick();
            await r.tools.invoke(toolId, {});
            await tick();
            await r.tools.invoke(toolId, {});
          },
          { id, endUserId: `user-${id}` },
        );
      await Promise.all([
        run("a", "deploy the app", "deploy_app"),
        run("b", "read the logs", "read_logs"),
      ]);
    });

    for (const event of ofType(events, "invoke_start")) {
      expect(event.turn_id).toBe(event.tool_id === "deploy_app" ? "a" : "b");
      expect(event.end_user_id).toBe(`user-${event.turn_id}`);
    }
    expect(ofType(events, "invoke_start")).toHaveLength(4);
    expect(ofType(events, "search").map((e) => [e.query, e.turn_id])).toEqual(
      expect.arrayContaining([
        ["deploy the app", "a"],
        ["read the logs", "b"],
      ]),
    );
  });

  it("lets a nested turn win and restores the outer one after it", async () => {
    const r = await runtimeWithTools();
    const seen: (string | undefined)[] = [];
    const events = await capture(r, () =>
      r.turn(
        async () => {
          seen.push(currentTurnId());
          await r.turn(
            async () => {
              seen.push(currentTurnId());
              await r.tools.invoke("deploy_app", {});
            },
            { id: "inner" },
          );
          seen.push(currentTurnId());
          await r.tools.invoke("read_logs", {});
        },
        { id: "outer", endUserId: "user-1" },
      ),
    );

    expect(seen).toEqual(["outer", "inner", "outer"]);
    expect(ofType(events, "turn_start").map((e) => [e.turn_id, e.end_user_id])).toEqual([
      ["outer", "user-1"],
      ["inner", "user-1"],
    ]);
    expect(ofType(events, "invoke_start").map((e) => [e.tool_id, e.turn_id])).toEqual([
      ["deploy_app", "inner"],
      ["read_logs", "outer"],
    ]);
  });

  it("lets an explicit turnId argument win over the scope", async () => {
    const r = await runtimeWithTools();
    const events = await capture(r, () =>
      r.turn(
        async () => {
          r.tools.search("deploy the app", 3, undefined, "explicit");
          await r.tools.invoke("deploy_app", {}, "explicit");
        },
        { id: "scoped", endUserId: "user-1" },
      ),
    );

    expect(ofType(events, "search")[0]).toMatchObject({
      turn_id: "explicit",
      end_user_id: "user-1",
    });
    expect(ofType(events, "invoke_end")[0]).toMatchObject({ turn_id: "explicit" });
  });

  it("emits turn_start once when the same turn id is opened again", async () => {
    const r = await runtimeWithTools();
    const events = await capture(r, async () => {
      await r.turn(async () => {}, { id: "req-1", userMessage: "first" });
      await r.turn(async () => {}, { id: "req-1", userMessage: "resumed" });
      await r.turn(async () => r.turn(async () => {}, { id: "req-1" }), { id: "req-1" });
    });

    expect(ofType(events, "turn_start")).toEqual([
      expect.objectContaining({ turn_id: "req-1", user_message: "first" }),
    ]);
  });

  it("lets a turn whose turn_start failed to record emit it on the next attempt", async () => {
    const r = await runtimeWithTools();
    const catalog = r.tools.catalog;
    const original = catalog.recordEvent.bind(catalog);
    catalog.recordEvent = () => {
      throw new Error("sink down");
    };
    expect(() => r.turn(() => {}, { id: "retry-turn" })).toThrow("sink down");
    expect(r.currentTurnId()).toBeUndefined();
    catalog.recordEvent = original;

    const events = await capture(r, () => r.turn(() => {}, { id: "retry-turn" }));

    expect(ofType(events, "turn_start").map((e) => e.turn_id)).toEqual(["retry-turn"]);
  });

  it("caps user_message at 4 KiB of UTF-8 without splitting a character", async () => {
    const r = await runtimeWithTools();
    const events = await capture(r, () =>
      r.turn(() => {}, { userMessage: "é".repeat(TURN_USER_MESSAGE_MAX_BYTES) }),
    );

    const message = String(ofType(events, "turn_start")[0]?.user_message);
    expect(Buffer.byteLength(message, "utf8")).toBe(TURN_USER_MESSAGE_MAX_BYTES);
    expect(message).toBe("é".repeat(TURN_USER_MESSAGE_MAX_BYTES / 2));
  });

  it("leaves events outside any turn without a turn id, as before", async () => {
    const r = await runtimeWithTools();
    const events = await capture(r, async () => {
      r.tools.search("deploy the app", 3);
      await r.tools.invoke("deploy_app", {});
    });

    expect(ofType(events, "turn_start")).toEqual([]);
    for (const event of events) {
      expect(event).not.toHaveProperty("turn_id");
      expect(event).not.toHaveProperty("end_user_id");
    }
  });

  it("carries the turn into the capability tools a model calls", async () => {
    const r = await runtimeWithTools();
    const tools = r.modelTools();
    const events = await capture(r, () =>
      r.turn(
        async () => {
          await tools[SEARCH_CAPABILITIES_ID]?.execute({ query: "deploy the app" });
          await tools[INVOKE_TOOL_ID]?.execute({ toolId: "deploy_app", args: {} });
        },
        { id: "model-turn" },
      ),
    );

    for (const type of ["gateway_search", "search", "gateway_invoke", "invoke_start"]) {
      expect(ofType(events, type).map((e) => e.turn_id)).toEqual(["model-turn"]);
    }
  });

  it("stamps SDK-owned events emitted inside a turn", async () => {
    const r = await runtimeWithTools();
    const events = await capture(r, () =>
      r.turn(
        () => {
          r.events.emit({ type: "experiment_skip", reason: "test" });
        },
        { id: "sdk-owned", endUserId: "user-2" },
      ),
    );

    expect(ofType(events, "experiment_skip")).toEqual([
      expect.objectContaining({ turn_id: "sdk-owned", end_user_id: "user-2" }),
    ]);
  });

  it("is shared by every adapted view of one core", async () => {
    const r = await runtimeWithTools();
    const view = r.adaptTo({
      name: "test",
      ingest: () => "passthrough",
      expose: (t) => t,
      recallMessages: () => [],
    });
    const events = await capture(r, () =>
      view.turn(
        async () => {
          expect(view.currentTurnId()).toBe("view-turn");
          await view.tools.invoke("deploy_app", {});
          view.recordToolCall({ toolId: "host_tool" });
        },
        { id: "view-turn" },
      ),
    );

    expect(ofType(events, "turn_start").map((e) => e.turn_id)).toEqual(["view-turn"]);
    expect(ofType(events, "invoke_end").map((e) => e.turn_id)).toEqual(["view-turn", "view-turn"]);
  });

  it("stamps the caller's active trace on turn_start", async () => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(new BasicTracerProvider());
    const r = await runtimeWithTools();
    let traceId: string | undefined;
    const events = await capture(r, () =>
      trace.getTracer("host").startActiveSpan("request", async (span) => {
        traceId = span.spanContext().traceId;
        await r.turn(async () => r.recordToolCall({ toolId: "host_tool" }), { id: "t" });
        span.end();
      }),
    );

    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ofType(events, "turn_start")[0]?.trace_id).toBe(traceId);
    expect(ofType(events, "invoke_end")[0]?.trace_id).toBe(traceId);
  });

  it("rejects a non-function body and bad options before opening the turn", async () => {
    const r = await runtimeWithTools();
    const events = await capture(r, () => {
      expect(() => r.turn(undefined as never)).toThrow(TypeError);
      expect(() => r.turn(() => {}, { id: "" })).toThrow(TypeError);
      expect(() => r.turn(() => {}, { userMessage: 1 as never })).toThrow(TypeError);
      expect(() => r.turn(() => {}, { endUserId: 1 as never })).toThrow(TypeError);
    });

    expect(ofType(events, "turn_start")).toEqual([]);
  });
});

describe("recordToolCall", () => {
  it("records a host-run tool as one external invocation lifecycle in the current turn", async () => {
    const r = await runtimeWithTools();
    const events = await capture(r, () =>
      r.turn(() => r.recordToolCall({ toolId: "web_search", tookMs: 12.4 }), {
        id: "turn-1",
        endUserId: "user-1",
      }),
    );

    const [start] = ofType(events, "invoke_start");
    const [end] = ofType(events, "invoke_end");
    expect(start).toMatchObject({
      tool_id: "web_search",
      args_size_bytes: 0,
      origin: "external",
      turn_id: "turn-1",
      end_user_id: "user-1",
    });
    expect(end).toMatchObject({
      tool_id: "web_search",
      took_ms: 12,
      origin: "external",
      turn_id: "turn-1",
      end_user_id: "user-1",
    });
    expect(end?.invocation_id).toBe(start?.invocation_id);
    expect(end?.event_id).not.toBe(start?.event_id);
    expect(ofType(events, "invoke_error")).toEqual([]);
  });

  it("records a failed call as invoke_error with the error message", async () => {
    const r = await runtimeWithTools();
    const events = await capture(r, () => {
      r.recordToolCall({ toolId: "web_search", tookMs: 5, error: new Error("rate limited") });
      r.recordToolCall({ toolId: "web_search", error: "timed out", turnId: "explicit" });
    });

    expect(ofType(events, "invoke_end")).toEqual([]);
    expect(ofType(events, "invoke_error")).toEqual([
      expect.objectContaining({ took_ms: 5, error: "rate limited", origin: "external" }),
      expect.objectContaining({ took_ms: 0, error: "timed out", turn_id: "explicit" }),
    ]);
    expect(ofType(events, "invoke_error")[0]).not.toHaveProperty("turn_id");
  });

  it("does not mark tools run through invoke as external", async () => {
    const r = await runtimeWithTools();
    const events = await capture(r, () => r.tools.invoke("deploy_app", {}).then(() => {}));

    expect(events.filter((e) => e.type.startsWith("invoke_"))).not.toHaveLength(0);
    for (const event of events) expect(event).not.toHaveProperty("origin", "external");
  });

  it("teaches adaptive ranking like an invoke", async () => {
    const catalog = new ToolCatalog();
    await catalog.register([
      tool("docker_build", "Build a Docker image from a Dockerfile"),
      tool("gh_run_list", "List CI workflow runs and whether the build passed"),
    ]);
    expect(catalog.search("why is the build broken", 5)[0]?.toolId).toBe("docker_build");
    const graph = new IntentGraph();
    catalog.experimentalEnableAdaptiveRanking(graph);

    for (const query of [
      "why is the build broken",
      "is the build broken again",
      "the build broken on main",
    ]) {
      catalog.turn(() => {
        catalog.search(query, 5, "agent");
        catalog.recordToolCall({ toolId: "gh_run_list", tookMs: 3 });
      });
    }

    expect(graph.clusterCount).toBe(1);
    const order = catalog.search("why is the build broken", 5).map((hit) => hit.toolId);
    expect(order.indexOf("gh_run_list")).toBeLessThan(order.indexOf("docker_build"));
  });

  it("rejects malformed calls without recording anything", async () => {
    const r = await runtimeWithTools();
    const events = await capture(r, () => {
      expect(() => r.recordToolCall({ toolId: "" })).toThrow(TypeError);
      expect(() => r.recordToolCall({ toolId: "x", tookMs: -1 })).toThrow(TypeError);
      expect(() => r.recordToolCall({ toolId: "x", tookMs: Number.NaN })).toThrow(TypeError);
      expect(() => r.recordToolCall({ toolId: "x", turnId: "" })).toThrow(TypeError);
      expect(() => r.recordToolCall(undefined as never)).toThrow(TypeError);
    });

    expect(events).toEqual([]);
  });
});
