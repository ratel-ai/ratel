// The runner only picks up `.ts`, so the view is built with createElement.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { McpConnect } from "@/components/console/mcp-setup/McpConnect";

/**
 * The Integrations page's connect panel: with browser sign-in (an edition's `mcpOAuth` port)
 * Claude Code needs no key, as upstream; without it the panel offers a key.
 */
const ENDPOINT = "https://ratel.example.com/api/mcp";

function render(browserSignIn?: boolean): string {
  return renderToStaticMarkup(
    createElement(McpConnect, {
      endpoint: ENDPOINT,
      organizationId: "org-1",
      organizationSlug: "acme",
      projects: [{ id: "p-1", name: "Support agent", slug: "support-agent" }],
      keyPrefixesByProject: { "p-1": [] },
      restricted: false,
      ...(browserSignIn === undefined ? {} : { browserSignIn }),
    }),
  );
}

test("with browser sign-in, Claude Code signs in and no key is offered", () => {
  const html = render(true);
  assert.match(html, /No API key needed/);
  assert.doesNotMatch(html, /Create a key and fill it in/);
  assert.doesNotMatch(html, /RATEL_API_KEY/);
});

test("without browser sign-in, Claude Code carries a key", () => {
  for (const html of [render(), render(false)]) {
    assert.doesNotMatch(html, /No API key needed/);
    assert.match(html, /Create a key and fill it in/);
    assert.match(html, /RATEL_API_KEY/);
  }
});

test("on a project's MCP page the key choice starts on that project, else on the first", () => {
  const panel = (initialProjectId?: string) =>
    renderToStaticMarkup(
      createElement(McpConnect, {
        endpoint: ENDPOINT,
        organizationId: "org-1",
        organizationSlug: "acme",
        projects: [
          { id: "p-1", name: "Support agent", slug: "support-agent" },
          { id: "p-2", name: "Sales agent", slug: "sales-agent" },
        ],
        initialProjectId,
        keyPrefixesByProject: { "p-1": [], "p-2": ["rtl_abc"] },
        restricted: false,
      }),
    );
  assert.match(panel("p-2"), /rtl_abc/);
  assert.match(panel("p-2"), /\/project\/p-2\/settings\/api-keys/);
  for (const html of [panel(), panel("p-unknown")]) {
    assert.match(html, /no API key yet/);
    assert.match(html, /\/project\/p-1\/settings\/api-keys/);
  }
});
