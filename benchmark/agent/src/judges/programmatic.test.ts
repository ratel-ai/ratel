import { describe, expect, it } from "vitest";
import { effectiveToolIds } from "../metering.js";
import type { ToolCall } from "../types.js";
import { judgeProgrammatic } from "./programmatic.js";

describe("judgeProgrammatic", () => {
  it("passes when the single gold tool is in the effective trace", () => {
    expect(judgeProgrammatic(["fs.read_file"], ["fs.read_file"]).verdict).toBe("pass");
  });

  it("passes when at least one of multiple gold tools is invoked (intersection-only)", () => {
    // ADR-0006: selection-only judge — pass iff effective ∩ gold ≠ ∅.
    const d = judgeProgrammatic(["fs.read_file", "mail.send"], ["fs.read_file"]);
    expect(d.verdict).toBe("pass");
    expect(d.missing_gold).toEqual(["mail.send"]);
  });

  it("fails when no gold id appears in the effective trace", () => {
    const d = judgeProgrammatic(["fs.read_file", "mail.send"], ["calendar.create_event"]);
    expect(d.verdict).toBe("fail");
    expect(d.missing_gold.sort()).toEqual(["fs.read_file", "mail.send"]);
    expect(d.extra_calls).toEqual(["calendar.create_event"]);
  });

  it("fails when the agent invoked nothing", () => {
    expect(judgeProgrammatic(["fs.read_file"], []).verdict).toBe("fail");
  });

  it("returns n/a when gold_tools is empty (defensive contract)", () => {
    // Shouldn't happen on MetaTool/ToolRet — every scenario has ≥1 gold tool —
    // but the judge stays defined when callers pass an empty set.
    expect(judgeProgrammatic([], ["anything"]).verdict).toBe("n/a");
  });

  it("flags non-gold ids as extras even on a passing verdict", () => {
    const d = judgeProgrammatic(["fs.read_file"], ["fs.read_file", "fs.delete_file"]);
    expect(d.verdict).toBe("pass");
    expect(d.extra_calls).toEqual(["fs.delete_file"]);
  });
});

describe("effectiveToolIds (gateway unwrap)", () => {
  it("unwraps invoke_tool calls into their inner toolId", () => {
    const calls: ToolCall[] = [
      { toolId: "search_tools", args: { query: "read file" } },
      { toolId: "invoke_tool", args: { toolId: "fs.read_file", args: { path: "/etc/hosts" } } },
    ];
    expect(effectiveToolIds(calls)).toEqual(["fs.read_file"]);
  });

  it("drops search_tools and keeps direct calls verbatim", () => {
    const calls: ToolCall[] = [
      { toolId: "search_tools", args: {} },
      { toolId: "fs.read_file", args: {} },
    ];
    expect(effectiveToolIds(calls)).toEqual(["fs.read_file"]);
  });

  it("ratel arm: gateway-style invocation passes the programmatic judge", () => {
    const calls: ToolCall[] = [
      { toolId: "search_tools", args: { query: "send email" } },
      {
        toolId: "invoke_tool",
        args: { toolId: "mail.send", args: { to: "x@y.com", subject: "hi", body: "x" } },
      },
    ];
    const verdict = judgeProgrammatic(["mail.send"], effectiveToolIds(calls));
    expect(verdict.verdict).toBe("pass");
  });

  it("invoke_tool without a string toolId is a no-op (model misuse, not a real call)", () => {
    const calls: ToolCall[] = [{ toolId: "invoke_tool", args: { args: { x: 1 } } }];
    expect(effectiveToolIds(calls)).toEqual([]);
  });
});
