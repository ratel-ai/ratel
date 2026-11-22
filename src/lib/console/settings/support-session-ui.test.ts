import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { ApiKeysTable } from "@/components/console/settings/ApiKeysTable";
import { DeleteProject } from "@/components/console/settings/DeleteProject";
import type { ApiKeySummary } from "@/lib/platform/api-key-actions";
import { SUPPORT_SESSION_RESTRICTED_MESSAGE } from "@/lib/platform/support-session";
import { renderWithRouter } from "./test-support";

/**
 * Settings inside an admin support session: what the operator may not do is shown disabled,
 * not offered and then refused on submit. Upstream's cases from
 * `lib/settings/v2/settings-view.test.ts`, a file the core does not carry (its other cases are
 * the private edition's pages); these are the core's components.
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

test("inside a support session keys can be read but not created or revoked", () => {
  const html = renderWithRouter(
    createElement(ApiKeysTable, {
      keys: [key()],
      projectSlug: "demo",
      organizationId: "o1",
      restricted: true,
      now: NOW,
    }),
  );
  assert.match(html, /role="note"/);
  assert.ok(html.includes(SUPPORT_SESSION_RESTRICTED_MESSAGE));
  assert.match(html, /<button[^>]*disabled=""[^>]*>.*Create API key/);
  assert.match(html, /<button(?=[^>]*aria-label="Revoke Staging")(?=[^>]*disabled="")/);
});

test("outside a support session keys are created and revoked as usual", () => {
  const html = renderWithRouter(
    createElement(ApiKeysTable, {
      keys: [key()],
      projectSlug: "demo",
      organizationId: "o1",
      restricted: false,
      now: NOW,
    }),
  );
  assert.doesNotMatch(html, /role="note"/);
  assert.doesNotMatch(html, /disabled=""/);
});

test("deleting a project starts from a named, typed confirmation", () => {
  const html = renderWithRouter(
    createElement(DeleteProject, { projectId: "p1", projectName: "Demo", restricted: false }),
  );
  assert.match(html, /Deletes <span[^>]*>Demo<\/span> with its API keys/);
  assert.match(html, /<button[^>]*>Delete project…<\/button>/);
  assert.doesNotMatch(html, /disabled=""/);
  const restricted = renderWithRouter(
    createElement(DeleteProject, { projectId: "p1", projectName: "Demo", restricted: true }),
  );
  assert.match(restricted, /Not available during an admin support session\./);
  assert.match(restricted, /<button[^>]*disabled=""[^>]*>Delete project…<\/button>/);
});
