import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSessions, projectBucketDir, slugifyProjectPath, summarizeSession } from "./inspect.js";

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
        origin: "direct",
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

  it("ls --all lists JSONL files across buckets newest-first", async () => {
    const bucketA = projectBucketDir(dir, "/Users/test/proj-a");
    await mkdir(bucketA, { recursive: true });
    await writeFile(
      join(bucketA, "a.jsonl"),
      JSON.stringify({ v: 1, ts: 1, session_id: "x", type: "search" }),
    );
    const bucketB = projectBucketDir(dir, "/Users/test/proj-b");
    await mkdir(bucketB, { recursive: true });
    await writeFile(
      join(bucketB, "b.jsonl"),
      JSON.stringify({ v: 1, ts: 2, session_id: "y", type: "search" }),
    );

    const out = await listSessions(dir, { all: true });
    expect(out).toContain("size");
    expect(out).toContain("a.jsonl");
    expect(out).toContain("b.jsonl");
  });
});

describe("slugifyProjectPath", () => {
  it("replaces every / with - and keeps the leading dash", () => {
    expect(slugifyProjectPath("/Users/example/path/to/project")).toBe(
      "-Users-example-path-to-project",
    );
  });

  it("replaces dots with dashes (CC parity)", () => {
    expect(slugifyProjectPath("/Users/rstagi/.ralph/worktrees/platform/issue-52")).toBe(
      "-Users-rstagi--ralph-worktrees-platform-issue-52",
    );
  });

  it("turns the bare root into a single dash", () => {
    expect(slugifyProjectPath("/")).toBe("-");
  });

  it("turns multiple consecutive dots into multiple dashes", () => {
    expect(slugifyProjectPath("/foo/...triple")).toBe("-foo----triple");
  });

  it("handles a leaf with multiple dots", () => {
    expect(slugifyProjectPath("/a/b.c.d")).toBe("-a-b-c-d");
  });
});

describe("projectBucketDir", () => {
  it("joins the global root with the slug of the absolute path", () => {
    const out = projectBucketDir("/tmp/r", "/Users/x/y");
    expect(out).toBe(join("/tmp/r", "-Users-x-y"));
  });
});

describe("ratel inspect — per-project buckets", () => {
  async function writeBucketFixture(
    project: string,
    name: string,
    lines: object[],
  ): Promise<string> {
    const bucket = projectBucketDir(dir, project);
    await mkdir(bucket, { recursive: true });
    const path = join(bucket, name);
    await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n"));
    return path;
  }

  it("summarizes the session for the given project's bucket", async () => {
    const project = "/Users/test/proj-a";
    await writeBucketFixture(project, "trace.jsonl", [
      { v: 1, ts: 1, session_id: "sA", type: "search", query: "x", origin: "direct" },
      { v: 1, ts: 2, session_id: "sA", type: "invoke_end", tool_id: "t", took_ms: 1 },
    ]);

    const out = await summarizeSession({ dir, project });
    expect(out).toContain("session sA");
  });

  it("returns a project-scoped no-telemetry message when the bucket is empty", async () => {
    const project = "/Users/test/empty-proj";
    const out = await summarizeSession({ dir, project });
    expect(out).toMatch(/no telemetry for this project/);
    expect(out).toContain("-Users-test-empty-proj");
  });

  it("does not surface another project's session when scoped by project", async () => {
    await writeBucketFixture("/Users/test/proj-a", "a.jsonl", [
      { v: 1, ts: 100, session_id: "sA", type: "search", query: "x", origin: "direct" },
    ]);
    await writeBucketFixture("/Users/test/proj-b", "b.jsonl", [
      { v: 1, ts: 200, session_id: "sB", type: "search", query: "x", origin: "direct" },
    ]);

    const out = await summarizeSession({ dir, project: "/Users/test/proj-a" });
    expect(out).toContain("session sA");
    expect(out).not.toContain("session sB");
  });

  it("with --all, walks every bucket and picks the global newest", async () => {
    await writeBucketFixture("/Users/test/proj-a", "a.jsonl", [
      { v: 1, ts: 100, session_id: "sA", type: "search", query: "x", origin: "direct" },
    ]);
    // Ensure proj-b's file has a newer mtime than proj-a's.
    await new Promise((r) => setTimeout(r, 10));
    await writeBucketFixture("/Users/test/proj-b", "b.jsonl", [
      { v: 1, ts: 200, session_id: "sB", type: "search", query: "x", origin: "direct" },
    ]);

    const out = await summarizeSession({ dir, all: true });
    expect(out).toContain("session sB");
  });

  it("--all on an empty root returns a root-scoped no-telemetry message", async () => {
    const out = await summarizeSession({ dir, all: true });
    expect(out).toMatch(/no telemetry under/);
  });

  it("ls scopes to the project's bucket by default", async () => {
    await writeBucketFixture("/Users/test/proj-a", "a.jsonl", [
      { v: 1, ts: 1, session_id: "sA", type: "search" },
    ]);
    await writeBucketFixture("/Users/test/proj-b", "b.jsonl", [
      { v: 1, ts: 2, session_id: "sB", type: "search" },
    ]);

    const out = await listSessions(dir, { project: "/Users/test/proj-a" });
    expect(out).toContain("a.jsonl");
    expect(out).not.toContain("b.jsonl");
  });

  it("ls --all enumerates buckets and prefixes the slug for disambiguation", async () => {
    await writeBucketFixture("/Users/test/proj-a", "a.jsonl", [
      { v: 1, ts: 1, session_id: "sA", type: "search" },
    ]);
    await writeBucketFixture("/Users/test/proj-b", "b.jsonl", [
      { v: 1, ts: 2, session_id: "sB", type: "search" },
    ]);

    const out = await listSessions(dir, { all: true });
    expect(out).toContain("-Users-test-proj-a");
    expect(out).toContain("-Users-test-proj-b");
    expect(out).toContain("a.jsonl");
    expect(out).toContain("b.jsonl");
  });
});
