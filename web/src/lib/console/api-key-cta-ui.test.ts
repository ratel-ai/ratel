import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { CollectingState } from "@/components/console/health/CollectingState";
import { SetupGuide } from "@/components/console/home/SetupGuide";
import { render, visibleText } from "@/lib/views/tasks/test-support";

const PROJECT = "p1";
const KEYS = `href="/project/${PROJECT}/settings/api-keys"`;

function setupGuide(hasApiKey: boolean): string {
  return render(
    createElement(SetupGuide, {
      projectId: PROJECT,
      hasApiKey,
      endpoint: "https://ratel.example/v1/traces",
      serviceName: "site-copilot",
    }),
  );
}

test("setup guide without a key: step 1 creates one", () => {
  const html = setupGuide(false);
  assert.match(html, new RegExp(`${KEYS}[^>]*>Create an API key<`));
  assert.match(visibleText(html), /Add the SDK and send a run/);
});

test("setup guide with the onboarding key: step 1 points at it, step 2 is the first trace", () => {
  const html = setupGuide(true);
  const text = visibleText(html);
  assert.match(text, /Your API key is ready/);
  assert.match(html, new RegExp(`${KEYS}[^>]*>View API keys<`));
  assert.match(text, /Add the SDK and send your first trace/);
  assert.doesNotMatch(text, /Create an API key/);
});

test("health v1 waiting state: create without a key, first trace and view with one", () => {
  const none = render(createElement(CollectingState, { projectId: PROJECT, turns: 0, floor: 50 }));
  assert.match(none, />Create an API key</);
  assert.doesNotMatch(none, /Send your first trace/);
  const keyed = render(
    createElement(CollectingState, { projectId: PROJECT, turns: 0, floor: 50, hasApiKey: true }),
  );
  assert.match(keyed, />Send your first trace<[\s\S]*>View API keys</);
  assert.doesNotMatch(keyed, /Create an API key/);
});
