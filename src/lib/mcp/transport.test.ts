import assert from "node:assert/strict";
import { test } from "node:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { SingleMessageTransport } from "./transport";

/**
 * The stateless transport's contract, and in particular what it does when an
 * operation never finishes.
 *
 * Returning nothing there is indistinguishable from a notification, so the
 * route answers 202 and the client waits forever for a reply to an id that is
 * never coming. It has to answer.
 */
function request(id: number, method = "tools/list"): JSONRPCMessage {
  return { jsonrpc: "2.0", id, method } as JSONRPCMessage;
}

test("a request gets whatever the server sent back", async () => {
  const transport = new SingleMessageTransport();
  transport.onmessage = (message) => {
    const id = (message as { id: number }).id;
    void transport.send({ jsonrpc: "2.0", id, result: { ok: true } } as JSONRPCMessage);
  };

  const out = await transport.handle(request(1));

  assert.equal(out.length, 1);
  assert.deepEqual((out[0] as { result: unknown }).result, { ok: true });
});

test("a notification resolves immediately with nothing to return", async () => {
  const transport = new SingleMessageTransport();
  let delivered = false;
  transport.onmessage = () => {
    delivered = true;
  };

  const out = await transport.handle({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  } as JSONRPCMessage);

  assert.deepEqual(out, [], "no id means no response is owed");
  assert.equal(delivered, true, "but it still reaches the server");
});

test("a request that never completes gets an error, not silence", async () => {
  const transport = new SingleMessageTransport();
  transport.onmessage = () => {
    // Deliberately never responds.
  };

  const out = await transport.handle(request(7), 20);

  assert.equal(out.length, 1, "silence would be read as 202 Accepted");
  const reply = out[0] as { id: number; error?: { code: number; message: string } };
  assert.equal(reply.id, 7, "the error must carry the id the client is waiting on");
  assert.equal(reply.error?.code, -32603);
  assert.match(reply.error?.message ?? "", /did not complete in time/);
});

test("a late timer does not add an error to a request that did answer", async () => {
  const transport = new SingleMessageTransport();
  transport.onmessage = (message) => {
    const id = (message as { id: number }).id;
    void transport.send({ jsonrpc: "2.0", id, result: { ok: true } } as JSONRPCMessage);
  };

  const out = await transport.handle(request(3), 1);

  assert.equal(out.length, 1, "a completed request must not be double-answered");
  assert.ok("result" in (out[0] as object));
});

test("closing settles a pending request rather than hanging", async () => {
  const transport = new SingleMessageTransport();
  transport.onmessage = () => {
    setTimeout(() => void transport.close(), 5);
  };

  const out = await transport.handle(request(9), 5_000);

  // Close resolves the wait; the request is then unanswered, so it earns the
  // same error a timeout would.
  assert.equal(out.length, 1);
  assert.equal((out[0] as { id: number }).id, 9);
});
