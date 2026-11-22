import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type PushStub, startPushStub } from "../test-support/push-stub.js";

// Drives the real `ratel sandbox push` from source (tsx) on the non-LLM fixture
// project, against the in-process push API stub. Never a real server.

const PROJECT = fileURLToPath(new URL("../test-support/sum-project/", import.meta.url));
const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");
const KEY = "rtl_test_push_key";
const OUT = mkdtempSync(join(tmpdir(), "ratel-push-"));

beforeAll(() => {
  writeFileSync(`${PROJECT}.env`, "SUM_REGION=eu-west-1\n");
  writeFileSync(`${PROJECT}.env.local`, "SUM_REGION=local\n");
  mkdirSync(`${PROJECT}node_modules/dep`, { recursive: true });
  writeFileSync(`${PROJECT}node_modules/dep/index.js`, "module.exports = 1;\n");
});

afterAll(() => {
  rmSync(`${PROJECT}.env`, { force: true });
  rmSync(`${PROJECT}.env.local`, { force: true });
  rmSync(`${PROJECT}node_modules`, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
});

let stub: PushStub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

function ratel(env: Record<string, string>, ...args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", TSX, MAIN, ...args], {
      cwd: PROJECT,
      env: { ...process.env, NO_COLOR: "1", RATEL_API_KEY: "", RATEL_URL: "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("ratel sandbox push --dry-run", () => {
  it("lists the bundle files and never includes .env files, node_modules or .git", async () => {
    const out = join(OUT, "bundle.tar.gz");
    const r = await ratel({}, "sandbox", "push", "--dry-run", "--out", out);
    expect(r.code).toBe(0);
    const files = r.stdout.split("\n\n")[0]?.split("\n") ?? [];
    expect(files).toEqual(["db/seed.sql", "in.json", "sum.sandbox.ts"]);
    expect(r.stdout).not.toMatch(/\.env|node_modules|\.git\//);
    expect(r.stdout).toMatch(/bundle\s+3 files, [\d.]+ (B|KB) \(tar\.gz of/);
    expect(r.stdout).toMatch(/would push sum-numbers \(dry run: nothing uploaded\)/);
    expect(existsSync(out)).toBe(true);
  }, 30_000);
});

describe("ratel sandbox push", () => {
  it("creates the version, uploads the bundle, finalizes it, and prints the version and URL", async () => {
    stub = await startPushStub({ apiKey: KEY });
    const r = await ratel(
      { RATEL_API_KEY: KEY },
      "sandbox",
      "push",
      "sum-numbers",
      "--url",
      stub.url,
    );
    expect(r.stderr).not.toMatch(/\n\s+at /);
    expect(r.code).toBe(0);
    expect(stub.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/v1/sandboxes/versions",
      "PUT /upload/sv_0001",
      "POST /api/v1/sandboxes/versions/sv_0001/finalize",
    ]);
    const [create, put, finalize] = stub.calls;
    expect(create?.authorization).toBe(`Bearer ${KEY}`);
    expect(put?.authorization).toBeUndefined(); // the key never goes to the upload URL
    const bundle = stub.bundles.get("sv_0001") as Buffer;
    const sha = createHash("sha256").update(bundle).digest("hex");
    expect(create?.body).toMatchObject({
      sandboxId: "sum-numbers",
      manifest: { sandboxes: [{ id: "sum-numbers", image: { base: "node:22-slim" } }] },
      bundle: { sha256: sha, bytes: bundle.length, files: 3 },
    });
    expect(finalize?.body).toEqual({ sha256: sha });
    expect(r.stdout).toMatch(/sum-numbers\s+version sv_0001\s+building/);
    expect(r.stdout).toContain(`playground  ${stub.url}/sandboxes/sum-numbers/versions/sv_0001`);
    expect(r.stderr).toMatch(/sum-numbers\s+uploading .* \(100%\)/);
  }, 30_000);

  it.each([
    [{}, ["sandbox", "push"], /set RATEL_API_KEY to a Ratel project key/],
    [{ RATEL_API_KEY: "rtl_wrong" }, ["sandbox", "push"], /refused the project key \(HTTP 401\)/],
    [{ RATEL_API_KEY: KEY }, ["sandbox", "push", "sum-numberz"], /unknown sandbox "sum-numberz"/],
    [{}, ["sandbox", "push", "--out", "x.tar.gz"], /--out works with --dry-run only/],
  ])(
    "exits non-zero with a clear message for %j %j",
    async (env, args, message) => {
      stub = await startPushStub({ apiKey: KEY });
      const r = await ratel(env, ...args, "--url", stub.url);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(message);
      expect(r.stderr).not.toMatch(/\n\s+at /);
    },
    30_000,
  );

  it("exits 1 when the version build failed, and still prints its URL", async () => {
    stub = await startPushStub({ apiKey: KEY, status: "failed" });
    const r = await ratel({ RATEL_API_KEY: KEY }, "sandbox", "push", "--url", stub.url);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/version sv_0001\s+failed: the image build failed \(stub\)/);
  }, 30_000);
});
