import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ReceivedFrame,
  startTestController,
  TEST_PROJECT_ID,
  type TestController,
} from "../test-support/controller.js";

// Drives the real `ratel dev` (from source, under tsx) against the in-process
// test controller, in a throwaway project so the file-change test can edit it.

const MAIN = fileURLToPath(new URL("../cli/main.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");
const INDEX = pathToFileURL(fileURLToPath(new URL("../index.ts", import.meta.url))).href;
const PROJECT_KEY = "rtl_test_project_key_0123456789";
const PROVIDER_SECRET = "sk-ant-not-a-real-key-SECRET-4242";

interface Dev {
  child: ChildProcess;
  stdout(): string;
  waitForOutput(text: string, timeoutMs?: number): Promise<void>;
  exited: Promise<number | null>;
}

function twinSource(maxTokens: number): string {
  return `import { twin } from ${JSON.stringify(INDEX)};
export default twin("workflow-label", {
  params: {
    model: twin.model("anthropic/claude-sonnet-5-5"),
    system: twin.prompt("You name agent workflows."),
    maxTokens: twin.int(${maxTokens}, { min: 50, max: 2000 }),
  },
  input: twin.structured({ type: "object", properties: { workflowId: { type: "string" } } }),
  run: async ({ input, params }) => ({ input, maxTokens: params.maxTokens }),
});
`;
}

function startRatelDev(cwd: string, url: string, apiKey = PROJECT_KEY): Dev {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NO_COLOR: "1", RATEL_API_KEY: apiKey };
  const child = spawn(process.execPath, ["--import", TSX, MAIN, "dev", "--url", url], { cwd, env });
  let out = "";
  const listeners = new Set<() => void>();
  const onData = (d: Buffer) => {
    out += d;
    for (const l of listeners) l();
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  return {
    child,
    stdout: () => out,
    exited,
    waitForOutput: (text, timeoutMs = 20_000) =>
      new Promise((resolve, reject) => {
        const check = () => {
          if (!out.includes(text)) return;
          listeners.delete(check);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`no "${text}" within ${timeoutMs} ms. Output:\n${out}`));
        }, timeoutMs);
        listeners.add(check);
        check();
      }),
  };
}

const registers = (c: TestController): ReceivedFrame[] =>
  c.frames.filter((f) => f.frame.type === "register");

describe("ratel dev against the test controller", () => {
  let project: string;
  let controller: TestController;
  let dev: Dev;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), "ratel-dev-"));
    mkdirSync(join(project, "agents"));
    writeFileSync(join(project, "agents", "label.twin.ts"), twinSource(400));
    writeFileSync(join(project, ".env"), `ANTHROPIC_API_KEY=${PROVIDER_SECRET}\n`);
    controller = await startTestController({ keys: [PROJECT_KEY] });
    dev = startRatelDev(project, controller.url);
  });

  afterAll(async () => {
    dev.child.kill("SIGKILL");
    await controller.close();
    rmSync(project, { recursive: true, force: true });
  });

  it("registers and prints one playground URL per twin", async () => {
    await dev.waitForOutput(`${controller.url}/project/${TEST_PROJECT_ID}/twins/workflow-label`);
    expect(dev.stdout()).toContain("connected (conn_1)");
    expect(controller.exchanges).toEqual([PROJECT_KEY]);
    expect(controller.sockets).toEqual(["tok_1"]);
    const [register] = registers(controller);
    expect(register?.frame.payload).toMatchObject({
      runner: { instanceId: expect.stringMatching(/^rnr_[0-9a-f]{16}$/) },
      manifest: {
        sdk: { language: "typescript", name: "@ratel-ai/twin" },
        twins: [{ id: "workflow-label", file: "agents/label.twin.ts" }],
      },
    });
    expect(controller.invalid).toEqual([]);
  });

  it("keeps keys in the process: the register payload holds provider key names only", () => {
    const [register] = registers(controller);
    expect(register?.frame.payload).toMatchObject({
      manifest: { providers: [{ provider: "anthropic", keys: ["ANTHROPIC_API_KEY"] }] },
    });
    for (const { raw } of controller.frames) {
      expect(raw).not.toContain(PROVIDER_SECRET);
      expect(raw).not.toContain(PROJECT_KEY);
    }
    // The project key goes to the token exchange only, never onto the socket URL.
    expect(controller.sockets.join()).not.toContain(PROJECT_KEY);
  });

  it("sends manifest.update on the same socket when a twin file changes", async () => {
    const before = controller.frames.length;
    writeFileSync(join(project, "agents", "label.twin.ts"), twinSource(500));
    const update = await controller.waitForFrame(
      (f) => f.frame.type === "manifest.update" && controller.frames.indexOf(f) >= before,
    );
    expect(update.connection).toBe(1);
    expect(update.frame.payload).toMatchObject({
      manifest: {
        twins: [
          {
            params: expect.arrayContaining([
              { name: "maxTokens", kind: "scalar", type: "int", default: 500, min: 50, max: 2000 },
            ]),
          },
        ],
      },
    });
    expect(controller.sockets).toEqual(["tok_1"]);
    expect(controller.invalid).toEqual([]);
    expect(dev.stdout()).toContain("manifest updated");
  });

  it("reconnects after a dropped socket with backoff and a fresh token", async () => {
    const droppedAt = Date.now();
    controller.dropAll();
    const second = await controller.waitForFrame(
      (f) => f.frame.type === "register" && f.connection === 2,
    );
    expect(Date.now() - droppedAt).toBeGreaterThanOrEqual(900);
    expect(controller.exchanges).toEqual([PROJECT_KEY, PROJECT_KEY]);
    expect(second.token).toBe("tok_2");
    // The new register carries the reloaded manifest.
    expect(JSON.stringify(second.frame.payload)).toContain('"default":500');
    await dev.waitForOutput("reconnected (conn_2)");
    expect(dev.stdout()).toMatch(/connection lost \(.+\); reconnecting in \d+\.\d s/);
    expect(controller.invalid).toEqual([]);
  });

  it("stops cleanly on Ctrl-C", async () => {
    dev.child.kill("SIGINT");
    expect(await dev.exited).toBe(0);
  });
});

describe("ratel dev with a refused key", () => {
  it("exits 1 and says the key was refused", async () => {
    const project = mkdtempSync(join(tmpdir(), "ratel-dev-"));
    writeFileSync(join(project, "a.twin.ts"), twinSource(400));
    const controller = await startTestController({ keys: ["rtl_other"] });
    try {
      const dev = startRatelDev(project, controller.url);
      expect(await dev.exited).toBe(1);
      expect(dev.stdout()).toContain("refused the project key (HTTP 401)");
      expect(controller.sockets).toEqual([]);
    } finally {
      await controller.close();
      rmSync(project, { recursive: true, force: true });
    }
  });
});
