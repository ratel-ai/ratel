import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Drives the real `ratel sandbox verify` from source (tsx) against the verify
// fixture project: a raw-client structured sandbox, and one that ignores its prompt.

const PROJECT = fileURLToPath(new URL("../test-support/verify-project/", import.meta.url));
const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function ratel(env: Record<string, string>, ...args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", TSX, MAIN, ...args], {
      cwd: PROJECT,
      env: { ...process.env, NO_COLOR: "1", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("ratel sandbox verify", () => {
  it("passes on the structured sandbox with its example input, and warns about real calls first", async () => {
    const result = await ratel({ ANTHROPIC_API_KEY: "set" }, "sandbox", "verify", "workflow-label");
    expect(result.stderr).toMatch(/calls its model with your own keys/);
    expect(result.stderr).toMatch(/run 1: no overrides/);
    expect(result.stdout).toMatch(/system\s+prompt\s+wired\s+sentinel seen in span/);
    expect(result.stdout).toMatch(/config hash\s+hash\s+wired/);
    expect(result.stdout).toMatch(/workflow-label: every param is wired/);
    expect(result.code).toBe(0);
  }, 60_000);

  it("exits 1 and names the prompt param the code ignores", async () => {
    const result = await ratel(
      { ANTHROPIC_API_KEY: "set" },
      "sandbox",
      "verify",
      "label-ignores-prompt",
    );
    expect(result.stdout).toMatch(/system\s+prompt\s+NOT WIRED/);
    expect(result.stdout).toMatch(/label-ignores-prompt: not wired: system/);
    expect(result.code).toBe(1);
  }, 60_000);
});
