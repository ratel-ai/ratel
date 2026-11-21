import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Drives the real `ratel` CLI from source (tsx), against the fixture project in
// test-support/project. Its `.env` and a poisoned node_modules twin are made
// here because both paths are git-ignored.

const PROJECT = fileURLToPath(new URL("../test-support/project/", import.meta.url));
const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");

beforeAll(() => {
  writeFileSync(`${PROJECT}.env`, "TWIN_FIXTURE_GREETING=hello from .env\n");
  mkdirSync(`${PROJECT}node_modules/poison`, { recursive: true });
  writeFileSync(
    `${PROJECT}node_modules/poison/bad.twin.js`,
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

function hashIn(stdout: string): string {
  return /config hash\s+([0-9a-f]{64})/.exec(stdout)?.[1] ?? "";
}

function outputIn(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  return JSON.parse(stdout.slice(start, end + 1));
}

describe("ratel twin list", () => {
  it("prints the fixture twin with its params and defaults", async () => {
    const r = await ratel("twin", "list");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("workflow-label");
    expect(r.stdout).toContain("agents/label.twin.ts");
    expect(r.stdout).toMatch(/model\s+model\s+anthropic\/claude-sonnet-5-5/);
    expect(r.stdout).toMatch(/maxTokens\s+int\s+400\s+50\.\.2000/);
  }, 30_000);

  it("prints the manifest as JSON with --json", async () => {
    const r = await ratel("twin", "list", "--json");
    const manifest = JSON.parse(r.stdout);
    expect(manifest.twins.map((t: { id: string }) => t.id)).toEqual(["workflow-label"]);
    expect(manifest.sdk.name).toBe("@ratel-ai/twin");
  }, 30_000);
});

describe("ratel twin run", () => {
  it("runs the twin in a child process with the defaults and the project .env", async () => {
    const r = await ratel("twin", "run", "workflow-label", "--input", "in.json");
    expect(r.stderr).toBe("");
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
    const base = await ratel("twin", "run", "workflow-label", "--input", "in.json");
    const r = await ratel(
      "twin",
      "run",
      "workflow-label",
      "--input",
      "in.json",
      "--set",
      "maxTokens=100",
      "--set",
      "model=anthropic/claude-haiku-5-5",
      "--tool",
      "createTicket=fake",
    );
    expect(r.code).toBe(0);
    expect(outputIn(r.stdout)).toMatchObject({ model: "claude-haiku-5-5", maxTokens: 100 });
    expect(r.stdout).toMatch(/changed\s+model, maxTokens/);
    expect(r.stdout).toMatch(/tool modes\s+createTicket=fake/);
    expect(hashIn(r.stdout)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIn(r.stdout)).not.toBe(hashIn(base.stdout));
  }, 30_000);

  it.each([
    [
      ["twin", "run", "workflow-lable", "--input", "in.json"],
      /unknown twin "workflow-lable".*workflow-label/,
    ],
    [
      ["twin", "run", "workflow-label", "--input", "in.json", "--set", "maxTokens=5000"],
      /workflow-label: maxTokens must be at most 2000/,
    ],
    [
      ["twin", "run", "workflow-label", "--input", "in.json", "--set", "maxTokens=many"],
      /workflow-label: maxTokens must be an integer/,
    ],
    [
      ["twin", "run", "workflow-label", "--input", "in.json", "--set", "temperature=1"],
      /workflow-label: temperature is an unknown param/,
    ],
    [
      ["twin", "run", "workflow-label", "--input", "in.json", "--set", "maxTokens"],
      /--set maxTokens: expected name=value/,
    ],
    [
      ["twin", "run", "workflow-label", "--input", "in.json", "--tool", "createTicket=mock"],
      /--tool createTicket=mock: mode must be real, fake or confirm/,
    ],
    [
      ["twin", "run", "workflow-label", "--input", "missing.json"],
      /cannot read --input missing\.json/,
    ],
    [["twin", "run", "workflow-label"], /--input <file> is required/],
    [["twin", "fly"], /unknown command "twin fly"/],
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
