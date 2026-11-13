import assert from "node:assert/strict";
import { test } from "node:test";
import { clientAddress, UNKNOWN_CLIENT_ADDRESS } from "./client-address";

function requestFrom(forwardedFor?: string): Request {
  return new Request("https://cloud.ratel.sh/api/mcp", {
    method: "POST",
    headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
  });
}

test("a single hop is the client", () => {
  assert.equal(clientAddress(requestFrom("203.0.113.7")), "203.0.113.7");
});

/**
 * The reason this reads the last hop rather than the first. Our ALB appends the
 * peer it actually accepted the connection from, so everything to the left is
 * whatever the caller chose to send. Keying a budget on the leftmost entry
 * would let one attacker present a fresh, empty bucket on every request.
 */
test("a forged prefix cannot displace the hop the load balancer appended", () => {
  const forged = clientAddress(requestFrom("10.0.0.1, 198.51.100.99, 203.0.113.7"));

  assert.equal(forged, "203.0.113.7");
});

test("whitespace and empty hops do not produce an empty key", () => {
  assert.equal(clientAddress(requestFrom(" 198.51.100.1 ,  , 203.0.113.7 ")), "203.0.113.7");
  assert.equal(clientAddress(requestFrom(" , ")), UNKNOWN_CLIENT_ADDRESS);
});

test("no header falls back to one shared bucket rather than to no limit", () => {
  assert.equal(clientAddress(requestFrom()), UNKNOWN_CLIENT_ADDRESS);
});
