import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { handlers } from "./executor.js";

const SCRIPTS_DIR = resolve(import.meta.dirname, "scripts");
const GENERATE = resolve(import.meta.dirname, "generate-scripts.ts");

describe("generate-scripts", () => {
  beforeAll(() => {
    execFileSync("tsx", [GENERATE], { timeout: 10_000 });
  });

  it("generates one .sh per handler", () => {
    const scripts = readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith(".sh"));
    expect(scripts.length).toBe(Object.keys(handlers).length);
  });

  it("each script calls run-tool.sh with correct tool name", () => {
    const scripts = readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith(".sh"));
    for (const script of scripts) {
      const toolName = script.replace(".sh", "");
      const content = readFileSync(resolve(SCRIPTS_DIR, script), "utf-8");
      expect(content).toContain("run-tool.sh");
      expect(content).toContain(`"${toolName}"`);
    }
  });

  it("each script is executable", () => {
    const scripts = readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith(".sh"));
    for (const script of scripts) {
      const stat = statSync(resolve(SCRIPTS_DIR, script));
      expect(stat.mode & 0o111).toBeGreaterThan(0);
    }
  });

  it("a generated script actually works end-to-end", async () => {
    const result = await new Promise<{ stdout: string; code: number | null }>((res) => {
      const child = execFile(
        "bash",
        [resolve(SCRIPTS_DIR, "listEmployees.sh")],
        { maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          res({ stdout, code: error?.code ? Number(error.code) : child.exitCode });
        },
      );
      child.stdin!.write("{}");
      child.stdin!.end();
    });
    expect(result.code).toBe(0);
    const employees = JSON.parse(result.stdout);
    expect(Array.isArray(employees)).toBe(true);
  });
});
