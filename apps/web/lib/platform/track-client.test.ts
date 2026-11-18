import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { type ClientAnalytics, installClientAnalytics } from "@/lib/contracts/client-analytics";
import { captureClientException, track } from "./track-client";

afterEach(() => installClientAnalytics(null));

function recorder() {
  const calls: unknown[][] = [];
  const analytics: ClientAnalytics = {
    track: (event, properties) => {
      calls.push(["track", event, properties]);
    },
    captureException: (error, properties) => {
      calls.push(["exception", error, properties]);
    },
  };
  return { calls, analytics };
}

test("with nothing installed, events and exceptions go nowhere and never throw", () => {
  track("mcp_snippet_copied", { client: "cursor" });
  captureClientException(new Error("x"), { digest: null, pathname: "/", boundary: "app" });
});

test("an installed edition receives the event and the exception with their properties", () => {
  const { calls, analytics } = recorder();
  installClientAnalytics(analytics);
  const error = new Error("boom");
  track("mcp_snippet_copied", { client: "cursor" });
  captureClientException(error, { digest: "d1", pathname: "/project/p", boundary: "global" });
  assert.deepEqual(calls, [
    ["track", "mcp_snippet_copied", { client: "cursor" }],
    ["exception", error, { digest: "d1", pathname: "/project/p", boundary: "global" }],
  ]);
});

test("an edition that throws never breaks the caller", () => {
  installClientAnalytics({
    track: () => {
      throw new Error("analytics down");
    },
    captureException: () => {
      throw new Error("analytics down");
    },
  });
  const original = console.error;
  console.error = () => {};
  try {
    track("mcp_snippet_copied", {});
    captureClientException(new Error("x"), { digest: null, pathname: "/", boundary: "app" });
  } finally {
    console.error = original;
  }
});
