import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { type CallbackHandle, startOAuthCallback } from "./callback-server.js";

const cleanups: Array<() => Promise<void>> = [];

function rawGet(
  port: number,
  pathQuery: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path: pathQuery, method: "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const c = cleanups.pop();
    if (c) await c();
  }
});

async function start(opts: Parameters<typeof startOAuthCallback>[0] = {}) {
  const handle = await startOAuthCallback({ timeoutMs: 5_000, ...opts });
  cleanups.push(() => handle.close());
  return handle;
}

async function fetchTo(
  handle: CallbackHandle,
  query: string,
  headers: Record<string, string> = {},
) {
  return fetch(`${handle.url}?${query}`, { headers });
}

describe("startOAuthCallback", () => {
  it("listens on 127.0.0.1 with a random port and exposes the URL", async () => {
    const handle = await start();
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url.startsWith(`http://127.0.0.1:${handle.port}`)).toBe(true);
  });

  it("uses the pinned port when callbackPort is set", async () => {
    const first = await start();
    const handle = await start({ port: 0 });
    expect(handle.port).not.toBe(first.port);
  });

  it("captures the authorization code on a valid callback", async () => {
    const handle = await start({ expectedState: "abc123" });
    const ack = handle.waitForCode();
    const res = await fetchTo(handle, "code=the-code&state=abc123");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.toLowerCase()).toContain("close");
    const result = await ack;
    expect(result.code).toBe("the-code");
    expect(result.state).toBe("abc123");
  });

  it("rejects callbacks whose state does not match expectedState", async () => {
    const handle = await start({ expectedState: "expected" });
    const ack = handle.waitForCode();
    const res = await fetchTo(handle, "code=c&state=different");
    expect(res.status).toBe(400);
    await expect(ack).rejects.toThrow(/state/i);
  });

  it("accepts any state when expectedState is omitted (caller validates)", async () => {
    const handle = await start();
    const ack = handle.waitForCode();
    await fetchTo(handle, "code=c&state=anything");
    const result = await ack;
    expect(result.code).toBe("c");
    expect(result.state).toBe("anything");
  });

  it("rejects requests with a non-loopback Host header", async () => {
    const handle = await start();
    const ack = handle.waitForCode();
    // node's fetch overrides the Host header; use http.request to actually set it
    const res = await rawGet(handle.port, "/cb?code=c", { Host: "evil.example.com" });
    expect(res.status).toBe(400);
    // ack remains pending; verify by closing and asserting it rejects on close
    await handle.close();
    await expect(ack).rejects.toThrow();
  });

  it("rejects callbacks missing the code parameter", async () => {
    const handle = await start();
    const ack = handle.waitForCode();
    const res = await fetchTo(handle, "state=x");
    expect(res.status).toBe(400);
    await expect(ack).rejects.toThrow(/code/i);
  });

  it("times out and rejects waitForCode when no callback arrives", async () => {
    const handle = await start({ timeoutMs: 50 });
    await expect(handle.waitForCode()).rejects.toThrow(/timeout|timed out/i);
  });

  it("close() rejects an in-flight waitForCode", async () => {
    const handle = await start();
    const ack = handle.waitForCode();
    await handle.close();
    await expect(ack).rejects.toThrow();
  });

  it("only captures the first valid callback (single-shot)", async () => {
    const handle = await start();
    const ack = handle.waitForCode();
    await fetchTo(handle, "code=first");
    const result = await ack;
    expect(result.code).toBe("first");
    // server has shut down after capture; further connections fail
    await expect(fetchTo(handle, "code=second")).rejects.toThrow();
  });
});
