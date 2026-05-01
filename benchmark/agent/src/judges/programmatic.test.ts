import { describe, expect, it } from "vitest";
import { effectiveToolIds } from "../metering.js";
import type { GoldCall, ToolCall } from "../types.js";
import { judgeProgrammatic } from "./programmatic.js";

describe("judgeProgrammatic", () => {
  const gold: GoldCall[] = [
    { tool_id: "fs.read_file", args: {}, response: {} },
    { tool_id: "mail.send", args: {}, response: {} },
  ];

  it("passes when all gold ids appear in the effective trace", () => {
    expect(judgeProgrammatic(gold, ["fs.read_file", "mail.send"]).verdict).toBe("pass");
  });

  it("passes when gold appears in any order", () => {
    expect(judgeProgrammatic(gold, ["mail.send", "fs.read_file"]).verdict).toBe("pass");
  });

  it("fails when a gold id is missing", () => {
    const d = judgeProgrammatic(gold, ["fs.read_file"]);
    expect(d.verdict).toBe("fail");
    expect(d.missing_gold).toEqual(["mail.send"]);
  });

  it("returns n/a when gold trace is empty", () => {
    expect(judgeProgrammatic([], ["anything"]).verdict).toBe("n/a");
  });

  it("flags non-gold ids as extras", () => {
    const d = judgeProgrammatic(gold, ["fs.read_file", "mail.send", "fs.delete_file"]);
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

  it("hybrid arm: gateway-style invocation passes the programmatic judge", () => {
    const calls: ToolCall[] = [
      { toolId: "search_tools", args: { query: "send email" } },
      {
        toolId: "invoke_tool",
        args: { toolId: "mail.send", args: { to: "x@y.com", subject: "hi", body: "x" } },
      },
    ];
    const verdict = judgeProgrammatic(
      [{ tool_id: "mail.send", args: {}, response: {} }],
      effectiveToolIds(calls),
    );
    expect(verdict.verdict).toBe("pass");
  });

  it("invoke_tool without a string toolId is a no-op (model misuse, not a real call)", () => {
    const calls: ToolCall[] = [{ toolId: "invoke_tool", args: { args: { x: 1 } } }];
    expect(effectiveToolIds(calls)).toEqual([]);
  });
});
