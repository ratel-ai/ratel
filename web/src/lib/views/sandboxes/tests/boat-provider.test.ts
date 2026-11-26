import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { type BoatProviderOptions, createBoatProvider } from "../adapters/boat-provider";
import {
  ProviderAtCapacity,
  ProviderRateLimited,
  ProviderRefused,
  ProviderUnavailable,
  type SandboxProvider,
  type StartVmRequest,
} from "../ports/sandbox-provider";
import { error, type FakeBoatServer, startFakeBoatServer } from "./fake-boat-server";

const KEY = "bk_test_secret_4411";

const RUN: StartVmRequest = {
  projectId: "p1",
  purpose: "run",
  ttlS: 1860,
  labels: { "ratel-run": "r1" },
  network: { inbound: "closed", outbound: { mode: "deny" } },
  keepSnapshots: false,
};
const PREPARE: StartVmRequest = {
  projectId: "p1",
  purpose: "prepare",
  ttlS: 2400,
  labels: { "ratel-version": "v1" },
  network: { inbound: "open", outbound: { mode: "open" } },
  keepSnapshots: true,
};

let server: FakeBoatServer;
before(async () => {
  server = await startFakeBoatServer();
});
after(async () => {
  await server.close();
});
beforeEach(() => {
  server.requests.length = 0;
  server.sandboxes.clear();
  server.snapshots.clear();
  server.intercept = () => undefined;
  server.pollsUntilReady = 1;
  server.pollsUntilSaved = 1;
  server.savedState = "ready";
  server.pageSize = 100;
});

function provider(over: Partial<BoatProviderOptions> = {}): SandboxProvider {
  return createBoatProvider({ apiKey: KEY, baseUrl: server.url, pollMs: 1, ...over });
}

const calls = (method: string, path: RegExp) =>
  server.requests.filter((request) => request.method === method && path.test(request.path));

describe("startVm", () => {
  test("starts a VM from the base image with no secrets of the account, and waits for Docker", async () => {
    server.pollsUntilReady = 3;
    const { vmRef } = await provider().startVm(PREPARE);
    const [create] = calls("POST", /\/sandboxes$/);
    assert.ok(create);
    assert.equal(create.headers.authorization, `Bearer ${KEY}`);
    assert.ok(create.headers["idempotency-key"]);
    assert.deepEqual(create.json, {
      type: "small",
      ttlSeconds: 2400,
      labels: { "ratel-version": "v1", "ratel-project": "p1", "ratel-purpose": "prepare" },
      noEnv: true,
      snapshots: true,
      network: { mode: "open", inbound: "open" },
    });
    assert.equal(calls("GET", new RegExp(`/sandboxes/${vmRef}$`)).length, 3);
    const [wait] = calls("POST", /\/commands$/);
    assert.match(String(wait?.json?.command), /docker info/);
  });

  test("starts a run VM from a snapshot, closed, with no snapshots", async () => {
    server.snapshots.set("rv-1", { name: "rv-1", status: "ready", polls: 0, files: new Map() });
    await provider({ vmType: "default" }).startVm({ ...RUN, fromSnapshot: "rv-1" });
    const [create] = calls("POST", /\/sandboxes$/);
    assert.equal(create?.json?.from, "rv-1");
    assert.equal(create?.json?.type, "default");
    assert.equal(create?.json?.snapshots, false);
    assert.equal(create?.json?.noEnv, true);
    assert.deepEqual(create?.json?.network, { mode: "deny", inbound: "boat-only" });
  });

  test("an allow list goes as the allow mode", async () => {
    const network = {
      inbound: "closed" as const,
      outbound: { mode: "allow" as const, allow: ["a.example"] },
    };
    await provider().startVm({ ...RUN, network });
    const [create] = calls("POST", /\/sandboxes$/);
    assert.deepEqual(create?.json?.network, {
      mode: "allow",
      allow: ["a.example"],
      inbound: "boat-only",
    });
  });

  test("a VM that fails to start is unavailable, and is deleted", async () => {
    server.intercept = (request) => {
      const sandbox = [...server.sandboxes.values()][0];
      if (request.method === "GET" && sandbox) sandbox.state = "error";
      return undefined;
    };
    await assert.rejects(provider().startVm(RUN), ProviderUnavailable);
    assert.equal(server.sandboxes.size, 0);
  });

  test("a VM whose Docker never answers is unavailable, and is deleted", async () => {
    const shell = server.shell;
    server.shell = () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: false });
    try {
      await assert.rejects(provider().startVm(RUN), ProviderUnavailable);
    } finally {
      server.shell = shell;
    }
    assert.equal(server.sandboxes.size, 0);
  });

  test("a lost answer is sent again with the same key", async () => {
    let failed = false;
    server.intercept = (request) => {
      if (request.method !== "POST" || !request.path.endsWith("/sandboxes") || failed) return;
      failed = true;
      return error(502, "bad_gateway");
    };
    await provider().startVm(RUN);
    const creates = calls("POST", /\/sandboxes$/);
    assert.equal(creates.length, 2);
    assert.equal(creates[0]?.headers["idempotency-key"], creates[1]?.headers["idempotency-key"]);
  });
});

describe("exec, files and snapshots", () => {
  const started = async (request = PREPARE) => {
    const target = provider({ inlineMaxBytes: 16 });
    const { vmRef } = await target.startVm(request);
    server.requests.length = 0;
    return { target, vmRef };
  };

  test("exec runs a command and gives its result", async () => {
    const { target, vmRef } = await started();
    assert.deepEqual(await target.exec(vmRef, { command: "echo hi", timeoutS: 5 }), {
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
      timedOut: false,
    });
    assert.equal((await target.exec(vmRef, { command: "exit 3", timeoutS: 5 })).exitCode, 3);
    const timedOut = await target.exec(vmRef, { command: "sleep 9", timeoutS: 2 });
    assert.deepEqual([timedOut.exitCode, timedOut.timedOut], [null, true]);
    assert.equal(calls("POST", /\/commands$/)[0]?.json?.timeoutSeconds, 5);
  });

  test("exec sends again a command that the VM was not ready for", async () => {
    const { target, vmRef } = await started();
    let refused = 0;
    server.intercept = (request) => {
      if (!request.path.endsWith("/commands") || refused >= 2) return;
      refused += 1;
      return error(409, "boat_starting");
    };
    assert.equal(
      (await target.exec(vmRef, { command: "echo again", timeoutS: 5 })).stdout,
      "again\n",
    );
    assert.equal(calls("POST", /\/commands$/).length, 3);
  });

  test("exec gives stdin through a file, never on the command line, and deletes it", async () => {
    const { target, vmRef } = await started();
    const stdin = "secret-stdin-value";
    assert.equal((await target.exec(vmRef, { command: "cat", timeoutS: 5, stdin })).stdout, stdin);
    const [command] = calls("POST", /\/commands$/);
    assert.doesNotMatch(String(command?.json?.command), /secret-stdin-value/);
    assert.deepEqual([...(server.sandboxes.get(vmRef)?.files.keys() ?? [])], []);
    assert.equal(calls("DELETE", /\/files$/).length, 1);
  });

  test("a long command runs detached and is polled", async () => {
    const { target, vmRef } = await started();
    const result = await target.exec(vmRef, { command: "echo long", timeoutS: 600 });
    assert.equal(result.stdout, "long\n");
    assert.equal(calls("POST", /\/commands$/)[0]?.json?.detached, true);
    assert.equal(calls("GET", /\/commands\/\d+$/).length, 1);
  });

  test("a small file goes inline", async () => {
    const { target, vmRef } = await started();
    const body = Buffer.from("A=1\n");
    await target.writeFile(vmRef, { path: "/tmp/run.env", body, size: body.length });
    assert.equal(server.sandboxes.get(vmRef)?.files.get("/tmp/run.env")?.toString(), "A=1\n");
    assert.equal(calls("PUT", /\/files$/)[0]?.json?.encoding, "base64");
  });

  test("a large file streams to an upload URL with no credentials", async () => {
    const { target, vmRef } = await started();
    const parts = [Buffer.from("0123456789"), Buffer.from("abcdefghij"), Buffer.from("XYZ")];
    const body = (async function* () {
      yield* parts;
    })();
    await target.writeFile(vmRef, { path: "/home/user/image.tar", body, size: 23 });
    const written = server.sandboxes.get(vmRef)?.files.get("/home/user/image.tar");
    assert.equal(written?.toString(), "0123456789abcdefghijXYZ");
    const [upload] = calls("PUT", /\/upload\//);
    assert.equal(upload?.headers.authorization, undefined);
    assert.equal(upload?.headers["content-length"], "23");
  });

  test("a snapshot is saved and polled until it is ready, and a VM starts from it", async () => {
    server.pollsUntilSaved = 3;
    const { target, vmRef } = await started();
    const body = Buffer.from("kept");
    await target.writeFile(vmRef, { path: "/home/user/kept", body, size: 4 });
    assert.deepEqual(await target.saveSnapshot(vmRef, "rv-1"), { snapshotRef: "rv-1" });
    assert.deepEqual(calls("POST", /\/saved-snapshots$/)[0]?.json, {
      sandboxId: vmRef,
      name: "rv-1",
    });
    assert.equal(calls("GET", /\/saved-snapshots\/rv-1$/).length, 3);
    const copy = await target.startVm({ ...RUN, fromSnapshot: "rv-1" });
    const read = await target.exec(copy.vmRef, { command: "cat /home/user/kept", timeoutS: 5 });
    assert.equal(read.stdout, "kept");
  });

  test("a snapshot that fails is unavailable, and the message does not name the service", async () => {
    server.savedState = "failed";
    const { target, vmRef } = await started();
    await assert.rejects(target.saveSnapshot(vmRef, "rv-2"), (thrown: unknown) => {
      assert.ok(thrown instanceof ProviderUnavailable);
      assert.doesNotMatch(thrown.message, /boat/i);
      return true;
    });
  });

  test("deletes are idempotent", async () => {
    const { target, vmRef } = await started();
    await target.saveSnapshot(vmRef, "rv-3");
    await target.deleteVm(vmRef);
    await target.deleteVm(vmRef);
    assert.equal(
      calls("DELETE", /\/sandboxes\/[^/]+$/)[0]?.headers["x-ascii-confirm-delete"],
      vmRef,
    );
    await target.deleteSnapshot("rv-3");
    await target.deleteSnapshot("rv-3");
    assert.equal(server.sandboxes.size, 0);
    assert.equal(server.snapshots.size, 0);
  });
});

describe("status and list", () => {
  test("the states of the service map to four states", async () => {
    const target = provider();
    const { vmRef } = await target.startVm(RUN);
    const sandbox = server.sandboxes.get(vmRef);
    assert.ok(sandbox);
    server.pollsUntilReady = Number.POSITIVE_INFINITY;
    const expected = {
      provisioning: "starting",
      provisioned: "starting",
      cloning: "starting",
      ready: "running",
      idle: "running",
      running: "running",
      archiving: "stopped",
      archived: "stopped",
      error: "stopped",
      cancelled: "gone",
    };
    for (const [state, mapped] of Object.entries(expected)) {
      sandbox.state = state;
      assert.deepEqual(await target.vmStatus(vmRef), { state: mapped }, state);
    }
    assert.deepEqual(await target.vmStatus("bx_zzzzzzzz"), { state: "gone" });
  });

  test("listVms filters by label and reads every page", async () => {
    server.pageSize = 1;
    const target = provider();
    const first = await target.startVm(RUN);
    const second = await target.startVm(RUN);
    await target.startVm(PREPARE);
    const listed = await target.listVms({ "ratel-purpose": "run", "ratel-project": "p1" });
    assert.deepEqual(
      listed.map((vm) => vm.vmRef),
      [first.vmRef, second.vmRef],
    );
    assert.ok(listed[0]?.createdAt instanceof Date);
    assert.equal(listed[0]?.labels["ratel-run"], "r1");
    const [list] = calls("GET", /\/sandboxes$/);
    assert.deepEqual(list?.query.getAll("label").sort(), ["ratel-project=p1", "ratel-purpose=run"]);
  });
});

describe("errors", () => {
  const failWith = (answer: ReturnType<typeof error>) => {
    server.intercept = (request) =>
      request.method === "POST" && request.path.endsWith("/sandboxes") ? answer : undefined;
  };
  const clean = (thrown: unknown) => {
    assert.ok(thrown instanceof Error);
    assert.doesNotMatch(thrown.message, /boat/i);
    assert.ok(!thrown.message.includes(KEY));
    assert.ok(!(thrown.stack ?? "").includes(KEY));
  };

  test("a start limit is rate limited, with the wait", async () => {
    failWith({ ...error(429, "rate_limited"), headers: { "retry-after": "7" } });
    await assert.rejects(provider().startVm(RUN), (thrown: unknown) => {
      assert.ok(thrown instanceof ProviderRateLimited);
      assert.equal(thrown.retryAfterS, 7);
      clean(thrown);
      return true;
    });
    assert.equal(calls("POST", /\/sandboxes$/).length, 1, "a limit is not sent again");
  });

  test("the limit of VMs at once is at capacity", async () => {
    for (const code of ["limit_reached", "member_limit_reached"]) {
      failWith({ ...error(429, code), headers: { "retry-after": "30" } });
      await assert.rejects(provider().startVm(RUN), (thrown: unknown) => {
        assert.ok(thrown instanceof ProviderAtCapacity, code);
        clean(thrown);
        return true;
      });
    }
  });

  test("a server error and a network error are unavailable", async () => {
    failWith(error(500, "internal"));
    await assert.rejects(provider().startVm(RUN), (thrown: unknown) => {
      assert.ok(thrown instanceof ProviderUnavailable);
      clean(thrown);
      return true;
    });
    const nowhere = createBoatProvider({
      apiKey: KEY,
      baseUrl: "http://127.0.0.1:1/api/v1",
      pollMs: 1,
    });
    await assert.rejects(nowhere.vmStatus("bx_22222222"), (thrown: unknown) => {
      assert.ok(thrown instanceof ProviderUnavailable);
      clean(thrown);
      return true;
    });
  });

  test("billing and permission are refused, with a readable message", async () => {
    for (const [status, code] of [
      [402, "billing_required"],
      [403, "api_key_action_forbidden"],
      [401, "unauthorized"],
    ] as const) {
      failWith(error(status, code));
      await assert.rejects(provider().startVm(RUN), (thrown: unknown) => {
        assert.ok(thrown instanceof ProviderRefused, code);
        assert.equal(thrown.status, status);
        assert.match(thrown.message, /sandbox service/);
        clean(thrown);
        return true;
      });
    }
  });
});
