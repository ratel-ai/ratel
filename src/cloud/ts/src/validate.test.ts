import { describe, expect, it } from "vitest";
import type { Event } from "./index.js";
import { validate } from "./index.js";

function minimal(): Event {
  return {
    provider: "openai",
    model: "gpt-5.5",
    ts: "2026-06-30T12:00:00Z",
    stream: false,
    messages: [{ role: "user", content: "hi" }],
  };
}

function paths(event: Event): string[] {
  const result = validate(event);
  return result.ok ? [] : result.issues.map((i) => i.path);
}

describe("validate", () => {
  it("accepts a minimal event", () => {
    expect(validate(minimal())).toEqual({ ok: true });
  });

  it("rejects empty provider, model, and ts", () => {
    const e = { ...minimal(), provider: "", model: "  ", ts: "" };
    const p = paths(e);
    expect(p).toContain("provider");
    expect(p).toContain("model");
    expect(p).toContain("ts");
  });

  it("rejects empty messages", () => {
    expect(paths({ ...minimal(), messages: [] })).toEqual(["messages"]);
  });

  it("rejects a tool_call block in a user message", () => {
    const e: Event = {
      ...minimal(),
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_call", id: "c1", name: "get_weather", arguments: { location: "Paris" } },
          ],
        },
      ],
    };
    expect(paths(e)).toEqual(["messages[0].content[0]"]);
  });

  it("allows a tool_call block in an assistant message", () => {
    const e: Event = {
      ...minimal(),
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_call", id: "c1", name: "get_weather", arguments: { location: "Paris" } },
          ],
        },
      ],
    };
    expect(validate(e)).toEqual({ ok: true });
  });

  it("rejects non-object tool-call arguments", () => {
    const e: Event = {
      ...minimal(),
      messages: [
        {
          role: "assistant",
          // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid arguments
          content: [{ type: "tool_call", id: "c1", name: "x", arguments: "nope" as any }],
        },
      ],
    };
    expect(paths(e)).toEqual(["messages[0].content[0].arguments"]);
  });

  it("rejects an image with neither source nor url", () => {
    const e: Event = {
      ...minimal(),
      messages: [{ role: "user", content: [{ type: "image", media_type: "image/png" }] }],
    };
    expect(paths(e)).toEqual(["messages[0].content[0]"]);
  });

  it("rejects a tool definition whose parameters are not an object", () => {
    const e: Event = {
      ...minimal(),
      // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid parameters
      tools: [{ name: "x", parameters: "nope" as any }],
    };
    expect(paths(e)).toEqual(["tools[0].parameters"]);
  });

  // Host-safety contract: `sendEvent` is documented never to throw, so `validate`
  // must report malformed input — including missing required fields — not throw.
  it("reports (does not throw on) an event missing required fields", () => {
    // biome-ignore lint/suspicious/noExplicitAny: simulates an untyped JS caller
    const e = { model: "x", ts: "x", messages: [{ role: "user", content: "hi" }] } as any;
    expect(() => validate(e)).not.toThrow();
    const result = validate(e);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.path)).toContain("provider");
  });

  it("does not throw on a fully empty object", () => {
    // biome-ignore lint/suspicious/noExplicitAny: simulates an untyped JS caller
    expect(() => validate({} as any)).not.toThrow();
    // biome-ignore lint/suspicious/noExplicitAny: simulates an untyped JS caller
    const result = validate({} as any);
    expect(result.ok).toBe(false);
  });

  it("reports non-object messages and blocks instead of throwing", () => {
    // biome-ignore lint/suspicious/noExplicitAny: simulates an untyped JS caller
    const e = { provider: "p", model: "m", ts: "t", messages: [null] } as any;
    expect(() => validate(e)).not.toThrow();
    expect(paths(e)).toEqual(["messages[0]"]);
  });
});
