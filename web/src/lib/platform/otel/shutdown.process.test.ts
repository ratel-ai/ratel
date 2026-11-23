import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./__fixtures__/real-process-shutdown.ts", import.meta.url));

type Outcome = {
  code: number | null;
  signal: NodeJS.Signals | null;
  flushed: boolean;
};

async function terminateFixtureWith(signal: NodeJS.Signals): Promise<Outcome> {
  const markerFile = join(mkdtempSync(join(tmpdir(), "otel-shutdown-")), "marker");
  const child = spawn(process.execPath, ["--import", "tsx", fixture], {
    env: { ...process.env, SHUTDOWN_MARKER_FILE: markerFile },
    stdio: ["ignore", "pipe", "inherit"],
  });

  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("READY")) resolve();
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error("child exited before it was ready")));
  });

  const exited = new Promise<Outcome>((resolve, reject) => {
    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child did not exit within budget after ${signal}`));
    }, 8_000);
    child.once("exit", (code, sig) => {
      clearTimeout(watchdog);
      resolve({
        code,
        signal: sig,
        flushed: existsSync(markerFile) && readFileSync(markerFile, "utf8").includes("flushed"),
      });
    });
  });

  child.kill(signal);
  return exited;
}

test("real SIGTERM flushes telemetry, then the app exits itself with 143", {
  timeout: 15_000,
}, async () => {
  const { code, signal, flushed } = await terminateFixtureWith("SIGTERM");
  assert.equal(flushed, true, "telemetry must flush before exit");
  assert.equal(signal, null, "the app must exit itself, not be killed by the signal");
  assert.equal(code, 143);
});

test("real SIGINT flushes telemetry, then the app exits itself with 130", {
  timeout: 15_000,
}, async () => {
  const { code, signal, flushed } = await terminateFixtureWith("SIGINT");
  assert.equal(flushed, true, "telemetry must flush before exit");
  assert.equal(signal, null, "the app must exit itself, not be killed by the signal");
  assert.equal(code, 130);
});
