import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ReactElement, type ReactNode } from "react";
import { CollectingState } from "@/components/console/health/CollectingState";
import { HealthStateV2 } from "@/components/console/health/v2/HealthStateV2";
import { SetupGuide } from "@/components/console/home/SetupGuide";
import { WithApiKeyCta } from "@/components/console/settings/WithApiKeyCta";
import { TracesNoTelemetry } from "@/components/console/traces/TracesNoTelemetry";
import { type ApiKeyCta, apiKeyCta, noApiKeyCta } from "@/lib/console/api-key-cta";
import { render, visibleText } from "@/lib/views/tasks/test-support";

const PROJECT = "p1";
const KEYS = `/project/${PROJECT}/settings/api-keys`;
const WITH_KEY = apiKeyCta(
  PROJECT,
  [
    {
      name: "Onboarding",
      keyPrefix: "rtl_abc",
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
      projectId: PROJECT,
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
  assert.match(text, /Onboarding · rtl_abc… · created Nov 20, 2026/);
  assert.match(text, /Next: add the SDK and send your first trace/);
  assert.doesNotMatch(text, /Create an API key/);
});

test("traces empty state: the key CTA follows the project's key", () => {
  const none = render(
    createElement(TracesNoTelemetry, { projectId: PROJECT, unit: "runs", apiKey: NO_KEY }),
  );
  assert.match(none, new RegExp(`href="${KEYS}"[^>]*>Create an API key<`));
  const keyed = render(
    createElement(TracesNoTelemetry, { projectId: PROJECT, unit: "runs", apiKey: WITH_KEY }),
  );
  assert.match(keyed, />Send your first trace</);
  assert.match(keyed, new RegExp(`href="${KEYS}"[^>]*>View API keys<`));
  assert.doesNotMatch(keyed, /Create an API key/);
});

test("health v1 waiting state: create without a key, first trace and view with one", () => {
  const none = render(
    createElement(CollectingState, { projectId: PROJECT, turns: 0, floor: 50, apiKey: NO_KEY }),
  );
  assert.match(none, new RegExp(`href="${KEYS}"[^>]*>(?:<svg[\\s\\S]*?</svg>)?Create an API key<`));
  const keyed = render(
    createElement(CollectingState, { projectId: PROJECT, turns: 0, floor: 50, apiKey: WITH_KEY }),
  );
  assert.match(keyed, /Send your first trace<[\s\S]*View API keys</);
  assert.doesNotMatch(keyed, /Create an API key|Get an API key/);
});

type Loader = ReactElement<{ projectId: string; children: (cta: ApiKeyCta) => ReactNode }>;

/** What a component returns when it is not given the CTA: the loader, for its own project. */
function loaderOf(node: ReactNode): Loader {
  const element = node as Loader;
  assert.equal(element.type, WithApiKeyCta, "reads the key through WithApiKeyCta");
  assert.equal(element.props.projectId, PROJECT);
  return element;
}

test("without a CTA each spot reads its own key, then draws with what it read", () => {
  const guide = loaderOf(
    SetupGuide({
      projectId: PROJECT,
      endpoint: "https://ratel.example/v1/traces",
      serviceName: "s",
    }),
  );
  assert.match(render(guide.props.children(WITH_KEY) as ReactElement), /Your API key is ready/);

  const traces = loaderOf(TracesNoTelemetry({ projectId: PROJECT, unit: "spans" }));
  assert.match(render(traces.props.children(WITH_KEY) as ReactElement), />View API keys</);

  const health = loaderOf(
    HealthStateV2({
      projectId: PROJECT,
      state: { kind: "nothing_yet" },
      windowDays: 7,
      canImport: false,
      billingHref: null,
    }),
  );
  assert.match(render(health.props.children(WITH_KEY) as ReactElement), />Send your first trace</);

  loaderOf(CollectingState({ projectId: PROJECT, turns: 0, floor: 50 }));
});

test("a state that does not offer the key never reads it", () => {
  const collecting = HealthStateV2({
    projectId: PROJECT,
    state: { kind: "too_few", turns: 3, floor: 50, imported: false, wider: null },
    windowDays: 7,
    canImport: false,
    billingHref: null,
  }) as ReactElement;
  assert.notEqual(collecting.type, WithApiKeyCta);
  const meter = CollectingState({ projectId: PROJECT, turns: 3, floor: 50 }) as ReactElement;
  assert.notEqual(meter.type, WithApiKeyCta);
});
