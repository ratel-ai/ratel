import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpOrigin, mcpResourceMetadataUrl, mcpResourceUrl } from "./public-origin";

/**
 * These pin the bug that made a real client hang.
 *
 * A developer on port 3210 got a 401 whose `resource_metadata` pointed at port
 * 3000, because the URL came from `publicUrl()` and that falls back to a
 * hardcoded localhost:3000. The client followed the pointer, found a different
 * server, and stopped with no browser ever opening and no error to read.
 */
function request(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: "POST", headers });
}

function withEnv<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.APP_PUBLIC_URL;
  if (value === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.APP_PUBLIC_URL;
    else process.env.APP_PUBLIC_URL = previous;
  }
}

test("with no configured origin, discovery stays on the port the client used", () => {
  withEnv(undefined, () => {
    assert.equal(mcpOrigin(request("http://localhost:3210/api/mcp")), "http://localhost:3210");
    assert.equal(
      mcpResourceMetadataUrl(request("http://localhost:3210/api/mcp")),
      "http://localhost:3210/.well-known/oauth-protected-resource/api/mcp",
    );
  });
});

test("a configured origin wins, because production is the authority on its own URL", () => {
  withEnv("https://cloud.ratel.sh", () => {
    assert.equal(mcpOrigin(request("http://10.0.1.7:3000/api/mcp")), "https://cloud.ratel.sh");
  });
});

test("a trailing slash in the configured origin does not double up", () => {
  withEnv("https://cloud.ratel.sh/", () => {
    assert.equal(
      mcpResourceUrl(request("http://localhost:3000/api/mcp")),
      "https://cloud.ratel.sh/api/mcp",
    );
  });
});

test("a forwarding proxy's host is preferred over the socket URL", () => {
  withEnv(undefined, () => {
    assert.equal(
      mcpOrigin(
        request("http://localhost:3210/api/mcp", {
          "x-forwarded-host": "demo.ngrok.app",
          "x-forwarded-proto": "https",
        }),
      ),
      "https://demo.ngrok.app",
    );
  });
});

test("the forwarded host is only trusted where no origin is configured", () => {
  // Production always sets APP_PUBLIC_URL, so a spoofed header cannot redirect
  // discovery there. This asserts that ordering rather than assuming it.
  withEnv("https://cloud.ratel.sh", () => {
    assert.equal(
      mcpOrigin(
        request("http://localhost:3000/api/mcp", {
          "x-forwarded-host": "attacker.example",
        }),
      ),
      "https://cloud.ratel.sh",
    );
  });
});

test("the resource identifier is the endpoint, not the bare origin", () => {
  withEnv(undefined, () => {
    // RFC 9728 wants the protected resource's own identifier. A client that
    // checks this against the URL it called rejects a bare origin.
    assert.equal(
      mcpResourceUrl(request("http://localhost:3210/api/mcp")),
      "http://localhost:3210/api/mcp",
    );
  });
});

test("the metadata path carries the resource path after the well-known segment", () => {
  withEnv("https://cloud.ratel.sh", () => {
    const metadata = mcpResourceMetadataUrl(request("https://cloud.ratel.sh/api/mcp"));

    assert.equal(metadata, "https://cloud.ratel.sh/.well-known/oauth-protected-resource/api/mcp");
    // The document has to live on the same origin as the endpoint, or the
    // client leaves this server mid-handshake.
    assert.ok(metadata.startsWith(mcpOrigin(request("https://cloud.ratel.sh/api/mcp"))));
  });
});
