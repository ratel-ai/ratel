import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { CollectingState } from "@/components/console/health/CollectingState";
import { SetupGuide } from "@/components/console/home/SetupGuide";
import { TracesEmpty } from "@/components/console/traces/TracesEmpty";
import { apiKeyCta, noApiKeyCta } from "@/lib/console/api-key-cta";
import { render, visibleText } from "@/lib/views/tasks/test-support";

const PROJECT = "p1";
const KEYS = `/project/${PROJECT}/settings/api-keys`;
const WITH_KEY = apiKeyCta(
  PROJECT,
  [
    {
      name: "Onboarding",
      keyPrefix: "rtl_a1b2c3d4",
      createdAt: new Date("2026-11-20T09:30:00Z"),
      revokedAt: null,
      expiresAt: null,
      scopes: ["*"],
    },
  ],
  new Date("2026-11-26T12:00:00Z"),
);
const NO_KEY = noApiKeyCta(PROJECT);

function setupGuide(apiKey: typeof WITH_KEY): string {
  return render(
    createElement(SetupGuide, {
      apiKey,
      endpoint: "https://ratel.example/v1/traces",
      serviceName: "site-copilot",
    }),
    { pathname: `/project/${PROJECT}` },
  );
}

test("setup guide without a key: step 1 creates one", () => {
  const html = setupGuide(NO_KEY);
  assert.match(html, new RegExp(`href="${KEYS}"[^>]*>Create an API key<`));
  assert.match(visibleText(html), /Add the SDK and send a run/);
  assert.doesNotMatch(html, /View API keys/);
});

test("setup guide with the onboarding key: step 1 is done and names it, the next step is the first trace", () => {
  const html = setupGuide(WITH_KEY);
  const text = visibleText(html);
  assert.match(text, /Your API key is ready/);
  assert.match(html, /aria-label="Step 1 done"/);
  assert.match(html, new RegExp(`href="${KEYS}"[^>]*>View API keys<`));
  assert.match(text, /Onboarding · rtl_a1b2c3d4… · created Nov 20, 2026/);
  assert.match(text, /Next: add the SDK and send your first trace/);
  assert.doesNotMatch(text, /Create an API key/);
});

test("traces empty state: the key CTA follows the project's key", () => {
  const none = render(
    createElement(TracesEmpty, { kind: "no-telemetry", unit: "runs", apiKey: NO_KEY }),
  );
  assert.match(none, new RegExp(`href="${KEYS}"[^>]*>Create an API key<`));
  const keyed = render(
    createElement(TracesEmpty, { kind: "no-telemetry", unit: "runs", apiKey: WITH_KEY }),
  );
  assert.match(keyed, />Send your first trace</);
  assert.match(keyed, new RegExp(`href="${KEYS}"[^>]*>View API keys<`));
  assert.doesNotMatch(keyed, /Create an API key/);
});

test("health v1 waiting state: create without a key, first trace and view with one", () => {
  const none = render(createElement(CollectingState, { projectId: PROJECT, turns: 0, floor: 50 }));
  assert.match(none, new RegExp(`href="${KEYS}"[^>]*>(?:<svg[\\s\\S]*?</svg>)?Create an API key<`));
  const keyed = render(
    createElement(CollectingState, { projectId: PROJECT, turns: 0, floor: 50, apiKey: WITH_KEY }),
  );
  assert.match(keyed, /Send your first trace<[\s\S]*View API keys</);
  assert.doesNotMatch(keyed, /Create an API key|Get an API key/);
});
