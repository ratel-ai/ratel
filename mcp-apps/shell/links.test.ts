import assert from "node:assert/strict";
import { test } from "node:test";
import { CONSOLE_ORIGIN_META, withConsoleOrigin } from "@/lib/mcp/server";
import { CONSOLE_ORIGIN, consoleOrigin, consoleUrl } from "./links";

/** A document holding one <meta name=…> as the server writes it. */
function docWith(name: string, content: string): Pick<Document, "querySelector"> {
  return {
    querySelector: ((selector: string) =>
      selector === `meta[name="${name}"]` ? { content } : null) as Document["querySelector"],
  };
}

test("the server writes the origin under the name the view reads", () => {
  const html = withConsoleOrigin("<html><head></head></html>", "http://localhost:3100/");
  const content = /<meta name="([^"]+)" content="([^"]+)">/.exec(html);
  assert.equal(content?.[1], CONSOLE_ORIGIN_META);
  assert.equal(consoleOrigin(docWith(content![1], content![2])), "http://localhost:3100");
});

test("withConsoleOrigin keeps only an http(s) origin, and leaves the HTML alone otherwise", () => {
  assert.equal(
    withConsoleOrigin("<head></head>", "https://staging.app.ratel.sh/api/mcp?x=1"),
    '<head><meta name="ratel-console-origin" content="https://staging.app.ratel.sh"></head>',
  );
  assert.equal(withConsoleOrigin("<head></head>", undefined), "<head></head>");
  assert.equal(withConsoleOrigin("<head></head>", "javascript:alert(1)"), "<head></head>");
  assert.equal(withConsoleOrigin("<head></head>", "not a url"), "<head></head>");
});

test("console links open the served origin, else app.ratel.sh", () => {
  // cloud.ratel.sh is a legacy deployment; the hosted console is app.ratel.sh.
  assert.equal(CONSOLE_ORIGIN, "https://app.ratel.sh");
  assert.equal(
    consoleOrigin(docWith(CONSOLE_ORIGIN_META, "http://localhost:3100")),
    "http://localhost:3100",
  );
  assert.equal(consoleOrigin(docWith(CONSOLE_ORIGIN_META, "javascript:alert(1)")), CONSOLE_ORIGIN);
  assert.equal(consoleOrigin(docWith("other", "http://localhost:3100")), CONSOLE_ORIGIN);
  assert.equal(consoleOrigin(undefined), CONSOLE_ORIGIN);
  assert.equal(
    consoleUrl("/project/p1/health", "http://localhost:3100"),
    "http://localhost:3100/project/p1/health",
  );
  assert.equal(
    consoleUrl("https://docs.ratel.sh/x", "http://localhost:3100"),
    "https://docs.ratel.sh/x",
  );
});

test("only http(s) leaves a view: other schemes are dropped, not opened", async () => {
  const { webUrl, openExternal, setLinkOpener } = await import("./links");
  assert.equal(webUrl("https://app.ratel.sh/x"), "https://app.ratel.sh/x");
  assert.equal(webUrl("http://127.0.0.1:3100/"), "http://127.0.0.1:3100/");
  for (const bad of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///etc/passwd",
    "vscode://x",
    "not a url",
  ])
    assert.equal(webUrl(bad), null, bad);
  const opened: string[] = [];
  setLinkOpener((url) => opened.push(url));
  openExternal("javascript:alert(1)");
  openExternal("https://app.ratel.sh/project/p1");
  setLinkOpener(null);
  assert.deepEqual(opened, ["https://app.ratel.sh/project/p1"]);
});

test("a link through the host: a new window only when the host has no open-link, never on a timeout", async () => {
  const { openThroughHost } = await import("./bridge");
  const { HostRequestError } = await import("./host-client");
  const fallback: string[] = [];
  const host = (error: unknown) => ({ openLink: async () => Promise.reject(error) });
  await openThroughHost(
    host(new HostRequestError(-32601, "Method not found")),
    "https://app.ratel.sh/a",
    (url) => fallback.push(url),
  );
  await openThroughHost(
    host(new HostRequestError(-32001, "Request timed out")),
    "https://app.ratel.sh/b",
    (url) => fallback.push(url),
  );
  assert.deepEqual(
    fallback,
    ["https://app.ratel.sh/a"],
    "a timeout may still be the host asking the person",
  );
  let asked = 0;
  await openThroughHost({ openLink: async () => (asked++, {}) }, "javascript:alert(1)", (url) =>
    fallback.push(url),
  );
  assert.equal(asked, 0);
  assert.equal(fallback.length, 1);
});

test("the Link shim renders a non-http(s) href without a destination", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { default: Link } = await import("./shims/next-link");
  assert.equal(
    renderToStaticMarkup(createElement(Link, { href: "javascript:alert(1)" }, "x")),
    "<a>x</a>",
  );
  assert.match(
    renderToStaticMarkup(createElement(Link, { href: "/project/p1" }, "x")),
    /href="https:\/\/app\.ratel\.sh\/project\/p1"/,
  );
});
