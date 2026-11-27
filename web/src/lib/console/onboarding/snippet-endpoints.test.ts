import assert from "node:assert/strict";
import { test } from "node:test";
import { setupGuides } from "@/components/console/health/setup-guides";
import { TOOL_CATALOG_SNIPPET } from "@/lib/console/catalog/sync-snippet";
import { buildQuickstart, QUICKSTART_LANGS } from "@/lib/console/onboarding/quickstart";
import { BASE_URL } from "@/lib/platform/app-config";
import type { SetupKey } from "@/lib/readings/trace-signals/setup-facts";
import { connectSnippet } from "@/lib/views/adaptive-ranking/setup";

/**
 * Every snippet the console or an agent hands out names this deployment's
 * address itself. The cloud SDK's built-in default is a hosted address, and
 * the legacy one (cloud.ratel.sh) answers a project key with 401: a snippet
 * that leans on the default sends its traces nowhere.
 */

/** Each SetupKey once; a new key fails typecheck here until it is listed. */
const SETUP_KEYS = Object.keys({
  otel_tool_spans: true,
  otel_model_calls: true,
  otel_conversation_id: true,
  otel_user_id: true,
  otel_content: true,
  otel_tool_definitions: true,
  otel_trace_context: true,
  sdk_tool_calls: true,
  sdk_search_queries: true,
  sdk_turn_ids: true,
  sdk_user_messages: true,
  sdk_end_users: true,
  both_linked: true,
} satisfies Record<SetupKey, true>) as SetupKey[];

const ENDPOINT = "https://ratel.example.com/v1/traces";

/** Every snippet, labelled, with the origin its address must start from. */
function allSnippets(): Array<{ label: string; code: string; origin: string }> {
  const quickstart = QUICKSTART_LANGS.flatMap((lang) =>
    [false, true].map((captureContent) => ({
      label: `quickstart ${lang}${captureContent ? " (capture)" : ""}`,
      code: buildQuickstart(lang, {
        endpoint: ENDPOINT,
        serviceName: "support-bot",
        captureContent,
      }).code,
      origin: new URL(ENDPOINT).origin,
    })),
  );
  const guides = SETUP_KEYS.flatMap((key) =>
    setupGuides(key).map((guide, index) => ({
      label: `setup guide ${key} #${index} (${guide.stack})`,
      code: guide.code,
      origin: BASE_URL,
    })),
  );
  return [
    ...quickstart,
    ...guides,
    { label: "catalog sync", code: TOOL_CATALOG_SNIPPET, origin: BASE_URL },
    { label: "adaptive ranking connect", code: connectSnippet("billing-agent"), origin: BASE_URL },
  ];
}

/** Calls into the cloud SDK that would otherwise fall back to its default address. */
const SDK_CALL = /(?:new RatelSpanProcessor|\battach|\battachIntentGraphSync)\(/g;
/** An address passed explicitly to one of them. */
const SDK_TARGET = /\b(?:baseUrl|endpoint): "([^"]+)"/g;

test("every cloud SDK call in a snippet is given this deployment's address", () => {
  let checked = 0;
  for (const { label, code, origin } of allSnippets()) {
    if (!code.includes("@ratel-ai/cloud-sdk")) continue;
    const calls = code.match(SDK_CALL) ?? [];
    const targets = [...code.matchAll(SDK_TARGET)].map((match) => match[1] ?? "");
    assert.ok(calls.length > 0, `${label} imports the cloud SDK and calls it`);
    assert.ok(
      targets.length >= calls.length,
      `${label}: ${calls.length} SDK call(s) but only ${targets.length} explicit address(es)`,
    );
    for (const target of targets) {
      assert.ok(target.startsWith(origin), `${label} points at ${origin}, not ${target}`);
    }
    checked += 1;
  }
  // The quickstart's TypeScript tab (twice), the search-queries guide, catalog
  // sync and the adaptive ranking connect snippet: a refactor that drops one
  // from the list above must not pass silently.
  assert.ok(checked >= 5, `checked ${checked} cloud SDK snippets`);
});

test("every quickstart snippet carries the endpoint it was built for", () => {
  for (const lang of QUICKSTART_LANGS) {
    for (const captureContent of [false, true]) {
      const { code } = buildQuickstart(lang, {
        endpoint: ENDPOINT,
        serviceName: "support-bot",
        captureContent,
      });
      assert.ok(code.includes(ENDPOINT), `${lang} names ${ENDPOINT}`);
    }
  }
});

test("no snippet names the legacy cloud.ratel.sh host", () => {
  for (const { label, code } of allSnippets()) {
    assert.equal(code.includes("cloud.ratel.sh"), false, `${label} names cloud.ratel.sh`);
  }
});
