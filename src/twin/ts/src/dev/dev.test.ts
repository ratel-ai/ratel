import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ReceivedFrame,
  startTestController,
  TEST_PROJECT_ID,
  type TestController,
} from "../test-support/controller.js";
import { type Dev, INDEX, PROJECT_KEY, startRatelDev } from "../test-support/ratel-dev.js";

// Drives the real `ratel dev` (from source, under tsx) against the in-process
// test controller, in a throwaway project so the file-change test can edit it.

const PROVIDER_SECRET = "sk-ant-not-a-real-key-SECRET-4242";

function twinSource(maxTokens: number, tag = "v1"): string {
  return `import { twin } from ${JSON.stringify(INDEX)};
export default twin("workflow-label", {
  params: {
    model: twin.model("anthropic/claude-sonnet-5-5"),
    system: twin.prompt("You name agent workflows."),
    maxTokens: twin.int(${maxTokens}, { min: 50, max: 2000 }),
  },
  input: twin.structured({ type: "object", properties: { workflowId: { type: "string" } } }),
  run: async ({ input, params }) => ({ input, maxTokens: params.maxTokens, tag: ${JSON.stringify(tag)} }),
});
`;
}

/** The newest register or manifest.update frame: the manifest the controller holds. */
function lastManifestFrame(c: TestController): ReceivedFrame | undefined {
  return c.frames
    .filter((f) => f.frame.type === "register" || f.frame.type === "manifest.update")
    .at(-1);
}

function revisionOf(f: ReceivedFrame | undefined): unknown {
  return (f?.frame.payload as { manifest?: { build?: { revision?: unknown } } }).manifest?.build
    ?.revision;
}

const registers = (c: TestController): ReceivedFrame[] =>
  c.frames.filter((f) => f.frame.type === "register");

// Each mode of hot reload once: `fs.watch` (the default; it falls back to
// polling where fs.watch fails), and polling forced with RATEL_TWIN_WATCH=poll.
const HOT_RELOAD_MODES: { mode: string; env: Record<string, string> }[] = [
  { mode: "default", env: {} },
  { mode: "poll", env: { RATEL_TWIN_WATCH: "poll" } },
];

describe.each(HOT_RELOAD_MODES)("ratel dev against the test controller (hot reload: $mode)", ({ mode, env }) => {
  let project: string;
  let controller: TestController;
  let dev: Dev;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), "ratel-dev-"));
    mkdirSync(join(project, "agents"));
    writeFileSync(join(project, "agents", "label.twin.ts"), twinSource(400));
    writeFileSync(join(project, ".env"), `ANTHROPIC_API_KEY=${PROVIDER_SECRET}\n`);
    controller = await startTestController({ keys: [PROJECT_KEY] });
    dev = startRatelDev(project, controller.url, PROJECT_KEY, env);
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
    if (mode === "poll") expect(dev.stdout()).toContain("hot reload now polls");
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

  it("sends manifest.update with a new revision when only the code of run() changes", async () => {
    const before = controller.frames.length;
    const updates = () =>
      controller.frames.slice(before).filter((f) => f.frame.type === "manifest.update");
    const previous = revisionOf(lastManifestFrame(controller));
    expect(previous).toMatch(/^[0-9a-f]{64}$/);
    // Same declared params and defaults, no git: only the body of run() changes.
    writeFileSync(join(project, "agents", "label.twin.ts"), twinSource(500, "v2"));
    await expect.poll(() => updates().length, { timeout: 15_000 }).toBe(1);
    const [update] = updates();
    expect(update?.connection).toBe(1);
    expect(revisionOf(update)).toMatch(/^[0-9a-f]{64}$/);
    expect(revisionOf(update)).not.toBe(previous);
    expect(controller.sockets).toEqual(["tok_1"]);
    expect(controller.invalid).toEqual([]);
  });

  it("keeps the last good manifest and child when a reload fails to load", async () => {
    const before = controller.frames.length;
    const good = revisionOf(lastManifestFrame(controller));
    writeFileSync(join(project, "agents", "label.twin.ts"), "export default twin(;\n");
    await dev.waitForOutput("reload failed");
    // The last good child still serves runs.
    controller.startRun("run_after_bad_reload");
    const end = await controller.waitForFrame(
      (f) => f.frame.type === "run.end" && f.frame.runId === "run_after_bad_reload",
    );
    expect(end.frame.payload).toMatchObject({ status: "ok", output: { tag: "v2" } });
    expect(controller.frames.slice(before).some((f) => f.frame.type === "manifest.update")).toBe(
      false,
    );
    expect(revisionOf(lastManifestFrame(controller))).toBe(good);
    // Fixing the file sends the update.
    writeFileSync(join(project, "agents", "label.twin.ts"), twinSource(500, "v3"));
    await controller.waitForFrame(
      (f) => f.frame.type === "manifest.update" && controller.frames.indexOf(f) >= before,
    );
    expect(controller.sockets).toEqual(["tok_1"]);
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
