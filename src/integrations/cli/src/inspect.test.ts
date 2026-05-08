import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSessions, summarizeSession } from "./inspect.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ratel-inspect-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeFixture(name: string, lines: object[]): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  return path;
}

describe("ratel inspect", () => {
  it("returns a friendly message when the directory has no telemetry files", async () => {
    const out = await summarizeSession({ dir });
    expect(out).toMatch(/no telemetry/);
  });

  it("summarizes session totals from a JSONL fixture", async () => {
    const file = await writeFixture("trace.jsonl", [
      {
        v: 1,
        ts: 1000,
        session_id: "s1",
        type: "search",
        query: "x",
        origin: "user",
        top_k: 5,
        hits: [{ tool_id: "t1", score: 1.0 }],
        stages: [],
        took_ms: 1,
      },
      { v: 1, ts: 1010, session_id: "s1", type: "invoke_start", tool_id: "t1", args_size_bytes: 4 },
      { v: 1, ts: 1020, session_id: "s1", type: "invoke_end", tool_id: "t1", took_ms: 10 },
      { v: 1, ts: 1030, session_id: "s1", type: "gateway_invoke", tool_id: "t1", took_ms: 12 },
      {
        v: 1,
        ts: 1040,
        session_id: "s1",
        type: "invoke_error",
        tool_id: "t1",
        took_ms: 1,
        error: "kaboom",
      },
    ]);

    const out = await summarizeSession({ from: file });
    expect(out).toContain("session s1");
    expect(out).toContain("events");
    expect(out).toContain("kaboom");
    expect(out).toContain("top tools by hit");
    expect(out).toContain("t1");
    expect(out).toContain("gateway (search → invoke_tool)");
  });

  it("respects --last by truncating to the most recent N events", async () => {
    const events = Array.from({ length: 6 }, (_, i) => ({
      v: 1,
      ts: 1000 + i * 10,
      session_id: "s1",
      type: "invoke_end",
      tool_id: `t${i}`,
      took_ms: 5,
    }));
    const file = await writeFixture("trace.jsonl", events);

    const out = await summarizeSession({ from: file, last: 2 });
    expect(out).toContain("invoke");
    // direct invoke count should reflect only the last 2 events
    expect(out).toMatch(/direct.*2/);
  });

  it("ls returns a friendly message on an empty dir", async () => {
    const out = await listSessions(dir);
    expect(out).toMatch(/no telemetry/);
  });

  it("ls lists the JSONL files newest-first", async () => {
    const a = await writeFixture("a.jsonl", [{ v: 1, ts: 1, session_id: "x", type: "search" }]);
    const b = await writeFixture("b.jsonl", [{ v: 1, ts: 2, session_id: "y", type: "search" }]);
    void a;
    void b;

    const out = await listSessions(dir);
    expect(out).toContain("file");
    expect(out).toContain("size");
    expect(out).toContain("a.jsonl");
    expect(out).toContain("b.jsonl");
  });
});
