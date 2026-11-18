import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { ApiKeyAccessPicker } from "@/components/console/settings/ApiKeyAccessPicker";
import { ApiKeysTable } from "@/components/console/settings/ApiKeysTable";
import type { ApiKeySummary } from "@/lib/platform/api-key-actions";
import { renderWithRouter } from "./test-support";

/**
 * Settings › API keys with scoped keys (RC-585): the list's Access column and the create dialog's
 * access picker. Upstream proves both in `lib/settings/v2/settings-view.test.ts`, a file the
 * private edition does not carry and whose other cases are its pages; these are the core's
 * components, so their cases are here.
 */

const NOW = "2026-10-18T12:00:00.000Z";

function key(overrides: Partial<ApiKeySummary> = {}): ApiKeySummary {
  return {
    id: "k1",
    name: "Staging",
    keyPrefix: "rtl_abcd1234",
    createdAt: "2026-10-01T12:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
    status: "active",
    scopes: ["*"],
    access: "full",
    publishable: false,
    ...overrides,
  };
}

test("the list shows each key's access, and which keys are safe in an app (RC-585)", () => {
  const keys = [
    key(),
    key({
      id: "k2",
      name: "Beluga app",
      keyPrefix: "rtl_pub_a1b2c3d4",
      scopes: ["ingest:traces", "ingest:logs", "ingest:events"],
      access: "ingest",
      publishable: true,
    }),
  ];
  const html = renderWithRouter(
    createElement(ApiKeysTable, {
      keys,
      projectSlug: "demo",
      organizationId: "o1",
      restricted: false,
      now: NOW,
    }),
  );
  assert.match(html, />Access</);
  assert.match(html, />Full access</);
  assert.match(html, />Ingest only</);
  assert.match(html, /safe to put in an app/);
});

test("the access picker says plainly which keys must stay secret and which are safe in an app", () => {
  const picker = (choice: "full" | "read_only" | "ingest" | "custom", scopes: string[] = []) =>
    renderWithRouter(
      createElement(ApiKeyAccessPicker, {
        name: "access",
        choice,
        scopes: scopes as never,
        onChoiceChange: () => {},
        onScopesChange: () => {},
      }),
    );
  const full = picker("full");
  assert.match(full, />Full access</);
  assert.match(full, />Read-only</);
  assert.match(full, />Ingest only</);
  assert.match(full, />Safe in an app</, "the ingest option is marked safe");
  assert.match(full, /Keep this key secret/);
  assert.doesNotMatch(full, /Send traces/, "single permissions stay hidden until Custom");
  assert.match(picker("read_only"), /Keep this key secret/);
  assert.match(picker("ingest"), /Safe to put in an app/);

  const custom = picker("custom", ["ingest:logs"]);
  assert.match(custom, /Send traces/);
  assert.match(custom, /Read captured content/);
  assert.match(custom, /Safe to put in an app/, "an ingest-only custom pick is publishable");
  assert.match(picker("custom", ["ingest:logs", "catalog:read"]), /Keep this key secret/);
});
