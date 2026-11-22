import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Drives the real `ratel` CLI from source (tsx), against the fixture project in
// test-support/project. Its `.env` and a poisoned node_modules sandbox are made
// here because both paths are git-ignored.

const PROJECT = fileURLToPath(new URL("../test-support/project/", import.meta.url));
const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");

beforeAll(() => {
  writeFileSync(`${PROJECT}.env`, "SANDBOX_FIXTURE_GREETING=hello from .env\n");
  mkdirSync(`${PROJECT}node_modules/poison`, { recursive: true });
  writeFileSync(
    `${PROJECT}node_modules/poison/bad.sandbox.js`,
    'throw new Error("node_modules was scanned");\n',
  );
});

afterAll(() => {
  rmSync(`${PROJECT}.env`, { force: true });
  rmSync(`${PROJECT}node_modules`, { recursive: true, force: true });
});

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  pid: number;
}

function ratel(...args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", TSX, MAIN, ...args], {
      cwd: PROJECT,
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr, pid: child.pid as number }));
  });
}

/**
 * The stderr lines of the CLI itself. Node prints runtime warnings there too
 * (Node 26: a deprecation of `module.register()` that tsx calls), which depend
 * on the Node version, not on the CLI.
 */
function ownLines(stderr: string): string[] {
  return stderr
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => !/^\(node:\d+\) /.test(line) && !/^\(Use `node --trace-/.test(line));
}

function hashIn(stdout: string): string {
  return /config hash\s+([0-9a-f]{64})/.exec(stdout)?.[1] ?? "";
}

function outputIn(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  return JSON.parse(stdout.slice(start, end + 1));
}

describe("ratel sandbox list", () => {
  it("prints the fixture sandbox with its params and defaults", async () => {
    const r = await ratel("sandbox", "list");
    expect(ownLines(r.stderr)).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("workflow-label");
    expect(r.stdout).toContain("agents/label.sandbox.ts");
    expect(r.stdout).toMatch(/model\s+model\s+anthropic\/claude-sonnet-5-5/);
    expect(r.stdout).toMatch(/maxTokens\s+int\s+400\s+50\.\.2000/);
  }, 30_000);

  it("prints the manifest as JSON with --json", async () => {
    const r = await ratel("sandbox", "list", "--json");
    const manifest = JSON.parse(r.stdout);
    expect(manifest.sandboxes.map((t: { id: string }) => t.id)).toEqual(["workflow-label"]);
    expect(manifest.sdk.name).toBe("@ratel-ai/sandbox");
  }, 30_000);
});

describe("ratel sandbox run", () => {
  it("runs the sandbox in a child process with the defaults and the project .env", async () => {
    const r = await ratel("sandbox", "run", "workflow-label", "--input", "in.json");
    expect(ownLines(r.stderr)).toEqual([]);
    expect(r.code).toBe(0);
    const output = outputIn(r.stdout);
    expect(output).toMatchObject({
      model: "claude-sonnet-5-5",
      maxTokens: 400,
      greeting: "hello from .env",
    });
    expect(output.pid).not.toBe(r.pid);
    expect(output.ppid).toBe(r.pid);
    expect(r.stdout).toMatch(/changed\s+\(none\)/);
  }, 30_000);

  it("applies --set inside run() and prints the changed names and a different hash", async () => {
    const base = await ratel("sandbox", "run", "workflow-label", "--input", "in.json");
    const r = await ratel(
      "sandbox",
      "run",
      "workflow-label",
      "--input",
      "in.json",
      "--set",
      "maxTokens=100",
      "--set",
      "model=anthropic/claude-haiku-5-5",
    );
    expect(r.code).toBe(0);
    expect(outputIn(r.stdout)).toMatchObject({ model: "claude-haiku-5-5", maxTokens: 100 });
    expect(r.stdout).toMatch(/changed\s+model, maxTokens/);
    expect(hashIn(r.stdout)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIn(r.stdout)).not.toBe(hashIn(base.stdout));
  }, 30_000);

  it.each([
    [
      ["sandbox", "run", "workflow-lable", "--input", "in.json"],
      /unknown sandbox "workflow-lable".*workflow-label/,
    ],
    [
      ["sandbox", "run", "workflow-label", "--input", "in.json", "--set", "maxTokens=5000"],
      /workflow-label: maxTokens must be at most 2000/,
    ],
    [
      ["sandbox", "run", "workflow-label", "--input", "in.json", "--set", "maxTokens=many"],
      /workflow-label: maxTokens must be an integer/,
    ],
    [
      ["sandbox", "run", "workflow-label", "--input", "in.json", "--set", "temperature=1"],
      /workflow-label: temperature is an unknown param/,
    ],
    [
      ["sandbox", "run", "workflow-label", "--input", "in.json", "--set", "maxTokens"],
      /--set maxTokens: expected name=value/,
    ],
    [
      ["sandbox", "run", "workflow-label", "--input", "in.json", "--tool", "createTicket=mock"],
      /--tool createTicket=mock: mode must be real, fake or confirm/,
    ],
    [
      ["sandbox", "run", "workflow-label", "--input", "in.json", "--tool", "createTicket=fake"],
      /workflow-label: toolModes createTicket: is an unknown tool/,
    ],
    [
      ["sandbox", "run", "workflow-label", "--input", "in.json", "--fake", "createTicket"],
      /--fake createTicket: expected name=value/,
    ],
    [
      ["sandbox", "run", "workflow-label", "--input", "missing.json"],
      /cannot read --input missing\.json/,
    ],
    [["sandbox", "run", "workflow-label"], /--input <file> is required/],
    [["sandbox", "fly"], /unknown command "sandbox fly"/],
  ])(
    "exits non-zero with a clear message for %j",
    async (args, message) => {
      const r = await ratel(...args);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(message);
      expect(r.stderr).not.toMatch(/\n\s+at /);
    },
    30_000,
  );
});

describe("a sandbox that makes no model call", () => {
  const SUM = fileURLToPath(new URL("../test-support/sum-project/", import.meta.url));
  const inSum = (...args: string[]) =>
    new Promise<CliResult>((resolve) => {
      const child = spawn(process.execPath, ["--import", TSX, MAIN, ...args], {
        cwd: SUM,
        env: { ...process.env, NO_COLOR: "1" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stdout, stderr, pid: child.pid as number }));
    });

  it("lists it with its image, output and state in the manifest", async () => {
    const r = await inSum("sandbox", "list", "--json");
    expect(r.code).toBe(0);
    const [sum] = JSON.parse(r.stdout).sandboxes;
    expect(sum).toMatchObject({
      id: "sum-numbers",
      state: "run",
      output: { kind: "structured" },
      image: { base: "node:22-slim", sidecars: [{ kind: "postgres" }, { kind: "redis" }] },
    });
  }, 30_000);

  it("runs it with a --set scale", async () => {
    const r = await inSum(
      "sandbox",
      "run",
      "sum-numbers",
      "--input",
      "in.json",
      "--set",
      "scale=2",
    );
    expect(ownLines(r.stderr)).toEqual([]);
    expect(r.code).toBe(0);
    expect(outputIn(r.stdout)).toEqual({ total: 13 });
  }, 30_000);

  it("verifies it: the params are skipped with the reason, not failed", async () => {
    const r = await inSum("sandbox", "verify", "sum-numbers");
    expect(r.stdout).toMatch(/scale\s+number\s+skipped\s+no model call/);
    expect(r.stdout).toMatch(/config hash\s+hash\s+wired/);
    expect(r.code).toBe(0);
  }, 60_000);
});
