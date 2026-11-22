import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  fixture,
  type OtlpKeyValue,
  startTestController,
  type TestController,
} from "../test-support/controller.js";
import { INDEX } from "../test-support/ratel-dev.js";

// `ratel sandbox serve` (instance mode, the container entrypoint) from source,
// against the in-process test controller: it dials with the instance token from
// its env, registers as an instance and serves runs. No project key, no exchange.

const MAIN = fileURLToPath(new URL("../cli/main.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");
const DB_PASSWORD = "pw-secret-9f3a"; // a secret the provider passes as a plain env var

const SANDBOX = `import { sandbox } from ${JSON.stringify(INDEX)};
export default sandbox("sum-numbers", {
  params: { scale: sandbox.number(1) },
  input: sandbox.structured({ type: "object" }),
  output: sandbox.output({ type: "object" }),
  state: "session",
  run: async ({ input, params, ctx }) => {
    ctx.log("db password is " + (process.env.DB_PASSWORD ? "set" : "missing"));
    ctx.log("instance token is " + (process.env.RATEL_INSTANCE_TOKEN ? "visible" : "hidden"));
    return { total: input.numbers.reduce((a, b) => a + b, 0) * params.scale };
  },
});
`;

interface Serve {
  child: ChildProcess;
  output(): string;
  exited: Promise<number | null>;
}

function serve(env: Record<string, string>, cwd: string): Serve {
  const child = spawn(process.execPath, ["--import", TSX, MAIN, "sandbox", "serve"], {
    cwd,
    env: { PATH: process.env.PATH, NO_COLOR: "1", ...env },
  });
  let out = "";
  child.stdout?.on("data", (d) => (out += d));
  child.stderr?.on("data", (d) => (out += d));
  return {
    child,
    output: () => out,
    exited: new Promise((resolve) => child.on("close", resolve)),
  };
}

describe("ratel sandbox serve against the test controller", () => {
  let project: string;
  let controller: TestController;
  let running: Serve | undefined;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), "ratel-serve-"));
    writeFileSync(join(project, "sum.sandbox.ts"), SANDBOX);
    // A project key in the bundle's .env must not be used: an instance has none.
    writeFileSync(join(project, ".env"), "RATEL_API_KEY=rtl_must_not_be_used\n");
    controller = await startTestController();
  });

  afterEach(() => {
    if (running?.child.exitCode === null) running.child.kill();
    running = undefined;
  });

  afterAll(async () => {
    await controller.close();
    rmSync(project, { recursive: true, force: true });
  });

  const start = (claims: Record<string, unknown>, extra: Record<string, string> = {}) => {
    const token = controller.issueInstanceToken(claims);
    running = serve(
      {
        RATEL_INSTANCE_TOKEN: token,
        RATEL_GATEWAY_URL: controller.gatewayUrl,
        RATEL_URL: controller.url,
        DB_PASSWORD,
        ...extra,
      },
      project,
    );
    return { token, serve: running };
  };

  it("registers as an instance, serves a run, exports its trace, and exits 0 on drain", async () => {
    const { token, serve: s } = start({ versionId: "sv_0001", sessionId: "ses_e2e" });
    const register = await controller.waitForFrame((f) => f.frame.type === "register");
    expect(register.frame.payload).toMatchObject({
      role: "instance",
      versionId: "sv_0001",
      sessionId: "ses_e2e",
      runner: { instanceId: expect.stringMatching(/^ins_[0-9a-f]{16}$/) },
      manifest: { sandboxes: [{ id: "sum-numbers", state: "session" }] },
    });
    expect(register.token).toBe(token);

    controller.startRun("run_serve_1", {
      sandboxId: "sum-numbers",
      sessionId: "ses_e2e",
      input: { numbers: [1, 2, 3] },
      params: { scale: 2 },
    });
    const end = await controller.waitForFrame(
      (f) => f.frame.runId === "run_serve_1" && f.frame.type === "run.end",
    );
    expect(end.frame.payload).toMatchObject({ status: "ok", output: { total: 12 } });
    const logs = controller
      .stored("run_serve_1")
      .filter((f) => f.type === "run.event")
      .map((f) => (f.payload as { message?: string }).message);
    expect(logs).toEqual(["db password is set", "instance token is hidden"]);

    // No project key and no token exchange.
    expect(controller.exchanges).toEqual([]);
    // Traces go out with the instance token, marked as a hosted instance.
    const traceId = (end.frame.payload as { traceId: string }).traceId;
    await expect
      .poll(() => exportedResource(controller, traceId), { timeout: 10_000 })
      .toBeDefined();
    expect(exportedResource(controller, traceId)).toMatchObject({
      key: token,
      resource: {
        "ratel.sandbox.instance": "hosted",
        "ratel.sandbox.version_id": "sv_0001",
        "ratel.sandbox.session_id": "ses_e2e",
      },
    });

    controller.send(fixture("drain.json"));
    expect(await s.exited).toBe(0);
    expect(s.output()).toContain("exiting: drained");
    expect(s.output()).not.toContain(DB_PASSWORD);
    expect(s.output()).not.toContain(token);
    expect(controller.invalid).toEqual([]);
  }, 60_000);

  it("exits 0 when the socket closes for good after the reconnect backoff", async () => {
    const { serve: s } = start({ versionId: "sv_0002" }, { RATEL_INSTANCE_MAX_RECONNECTS: "1" });
    await controller.waitForFrame(
      (f) =>
        f.frame.type === "register" &&
        (f.frame.payload as { versionId?: string }).versionId === "sv_0002",
    );
    // The token opened one socket: the reconnect with it is refused, as an expired one would be.
    controller.dropAll();
    expect(await s.exited).toBe(0);
    expect(s.output()).toMatch(/exiting: the connection closed for good/);
  }, 60_000);

  it.each([
    [{}, /needs RATEL_INSTANCE_TOKEN and RATEL_GATEWAY_URL/],
    [
      { RATEL_INSTANCE_TOKEN: "not-a-token", RATEL_GATEWAY_URL: "ws://127.0.0.1:1" },
      /is not an instance token: it has no versionId claim/,
    ],
  ])(
    "exits 1 with a clear message for %j",
    async (env, message) => {
      running = serve(env, project);
      expect(await running.exited).toBe(1);
      expect(running.output()).toMatch(message);
    },
    30_000,
  );
});

function exportedResource(controller: TestController, traceId: string) {
  for (const { key, body } of controller.traces) {
    for (const rs of body.resourceSpans) {
      if (rs.scopeSpans.some((ss) => ss.spans.some((s) => s.traceId === traceId))) {
        return { key, resource: plain(rs.resource.attributes) };
      }
    }
  }
  return undefined;
}

function plain(attributes: OtlpKeyValue[]): Record<string, unknown> {
  return Object.fromEntries(
    attributes.map((a) => [a.key, a.value.stringValue ?? a.value.boolValue ?? a.value.intValue]),
  );
}
