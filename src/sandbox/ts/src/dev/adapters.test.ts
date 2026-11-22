import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startTestController,
  TEST_PROJECT_ID,
  type TestController,
} from "../test-support/controller.js";
import { ConnectError, exchangeToken, runnerSocketUrl } from "./connect-http.js";
import { openSocket } from "./ws-socket.js";

// Contract tests of the HTTP and websocket adapters against the test controller.

const KEY = "rtl_contract";
let controller: TestController;

beforeEach(async () => {
  controller = await startTestController({ keys: [KEY] });
});

afterEach(async () => {
  await controller.close();
});

describe("exchangeToken", () => {
  it("trades the project key for a gateway URL, a token and the project", async () => {
    const grant = await exchangeToken({ baseUrl: controller.url, apiKey: KEY });
    expect(grant).toMatchObject({
      gatewayUrl: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
      token: "tok_1",
      projectId: TEST_PROJECT_ID,
    });
    expect(Date.parse(grant.expiresAt ?? "")).toBeGreaterThan(Date.now());
    expect(controller.exchanges).toEqual([KEY]);
  });

  it.each([
    [401, true],
    [403, true],
    [404, true],
    [503, false],
  ])("maps HTTP %i to a ConnectError with fatal=%s", async (status, fatal) => {
    controller.failConnectWith = status;
    const err = await exchangeToken({ baseUrl: controller.url, apiKey: KEY }).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect(err).toMatchObject({ fatal, status });
  });

  it("is not fatal when the host cannot be reached", async () => {
    const err = await exchangeToken({ baseUrl: "http://127.0.0.1:1", apiKey: KEY }).catch((e) => e);
    expect(err).toMatchObject({ name: "ConnectError", fatal: false });
  });
});

describe("runnerSocketUrl", () => {
  it("adds /runner and the token, keeping a path prefix", () => {
    expect(runnerSocketUrl("wss://gw.ratel.sh", "a b")).toBe("wss://gw.ratel.sh/runner?token=a+b");
    expect(runnerSocketUrl("wss://ratel.sh/gw/", "t")).toBe("wss://ratel.sh/gw/runner?token=t");
  });
});

describe("openSocket", () => {
  it("opens, sends text frames both ways and reports one close on a drop", async () => {
    const grant = await exchangeToken({ baseUrl: controller.url, apiKey: KEY });
    const events: string[] = [];
    const closed = new Promise<void>((resolve) => {
      const socket = openSocket(runnerSocketUrl(grant.gatewayUrl, grant.token), {
        onOpen: () => {
          events.push("open");
          socket.send(JSON.stringify({ v: 1, type: "ping", id: "x", ts: "t", payload: {} }));
        },
        onText: (text) => events.push(`text:${JSON.parse(text).type}`),
        onClose: () => {
          events.push("close");
          resolve();
        },
      });
    });
    await controller.waitForFrame((f) => f.frame.type === "ping");
    controller.send({ v: 1, type: "drain", id: "c", ts: new Date().toISOString(), payload: {} });
    await new Promise((r) => setTimeout(r, 50));
    controller.dropAll();
    await closed;
    expect(events).toEqual(["open", "text:drain", "close"]);
  });

  it("reports a refused upgrade as one close", async () => {
    const reasons: string[] = [];
    await new Promise<void>((resolve) => {
      openSocket(runnerSocketUrl(controller.url.replace("http", "ws"), "tok_unknown"), {
        onOpen: () => reasons.push("open"),
        onText: () => {},
        onClose: (reason) => {
          reasons.push(reason);
          resolve();
        },
      });
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).not.toBe("open");
  });
});
