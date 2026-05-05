import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { resolve } from "node:path";

const RUN_TOOL = resolve(import.meta.dirname, "run-tool.ts");

function runTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = execFile(
      "tsx",
      [RUN_TOOL, toolName],
      { maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ stdout, stderr, code: error?.code ? Number(error.code) : child.exitCode });
      },
    );
    child.stdin!.write(JSON.stringify(args));
    child.stdin!.end();
  });
}

describe("run-tool", () => {
  it("exits 1 with error for unknown tool", async () => {
    const { stderr, code } = await runTool("nonExistentTool", {});
    expect(code).toBe(1);
    const err = JSON.parse(stderr);
    expect(err.error).toContain("Unknown tool");
  });

  it("exits 1 on invalid JSON stdin", async () => {
    const result = await new Promise<{ stderr: string; code: number | null }>((res) => {
      const child = execFile("tsx", [RUN_TOOL, "getEmployee"], { maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
        res({ stderr, code: error?.code ? Number(error.code) : child.exitCode });
      });
      child.stdin!.write("not json{{{");
      child.stdin!.end();
    });
    expect(result.code).toBe(1);
    const err = JSON.parse(result.stderr);
    expect(err.error).toBeDefined();
  });

  it("handles empty stdin as empty args", async () => {
    const result = await new Promise<{ stdout: string; code: number | null }>((res) => {
      const child = execFile("tsx", [RUN_TOOL, "listEmployees"], { maxBuffer: 1024 * 1024 }, (error, stdout) => {
        res({ stdout, code: error?.code ? Number(error.code) : child.exitCode });
      });
      child.stdin!.end();
    });
    expect(result.code).toBe(0);
    const employees = JSON.parse(result.stdout);
    expect(Array.isArray(employees)).toBe(true);
    expect(employees.length).toBeGreaterThan(0);
  });

  it("returns JSON result for known tool", async () => {
    const { stdout, code } = await runTool("getEmployee", { employeeId: "EMP001" });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.id).toBe("EMP001");
    expect(result.name).toBe("Marco Rossi");
  });
});
