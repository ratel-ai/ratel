import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentPromptPanel } from "@/components/console/onboarding/AgentPromptPanel";
import { CaptureConsentPanel } from "@/components/console/onboarding/CaptureConsentPanel";
import { SdkQuickstart } from "@/components/console/onboarding/SdkQuickstart";
import {
  CAPTURE_TOGGLE_LABEL,
  CAPTURE_TOGGLE_NOTE,
  FIRST_READING_PROMISE,
  KEEP_BACK_NOTE,
  READ_SOURCES,
  RELAY_PRIVACY_LEVELS,
} from "@/lib/console/onboarding/capture-consent";
import { QUICKSTART_CAPTURE_ENV } from "@/lib/console/onboarding/quickstart";

function renderPanel(captureContent = false): string {
  return renderToStaticMarkup(
    createElement(CaptureConsentPanel, {
      captureContent,
      onCaptureContentChange: () => {},
    }),
  );
}

test("the panel lists the three ways Ratel reads telemetry, in order", () => {
  const html = renderPanel();
  assert.match(html, /What Ratel will read/);

  const rows = [...html.matchAll(/data-read-source="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rows, ["runtime-events", "content-capture", "local-relay"]);
  assert.deepEqual(
    READ_SOURCES.map((source) => source.name),
    ["Runtime events", "Content capture", "ratel-local relay"],
  );
  for (const source of READ_SOURCES) {
    assert.ok(html.includes(source.name), `${source.id} is named`);
    assert.ok(html.includes(source.status), `${source.id} says how it is switched on`);
  }
});

test("the relay row lists every privacy level, least to most", () => {
  const html = renderPanel();
  const relay = html.slice(html.indexOf('data-read-source="local-relay"'));
  let cursor = 0;
  for (const level of RELAY_PRIVACY_LEVELS) {
    const at = relay.indexOf(`>${level}<`, cursor);
    assert.ok(at > cursor, `${level} is listed after the level before it`);
    cursor = at;
  }
});

test("the panel makes the first-reading promise and says partial is fine", () => {
  const html = renderPanel();
  assert.ok(html.includes(FIRST_READING_PROMISE));
  assert.ok(html.includes(KEEP_BACK_NOTE));
  assert.equal(
    FIRST_READING_PROMISE,
    "First reading within 24 hours or 50 turns, whichever comes first.",
  );
});

test("the content-capture switch is labelled, reachable, and starts off", () => {
  const html = renderPanel();
  const button = html.match(/<button[^>]*role="switch"[^>]*>/)?.[0];
  assert.ok(button, "a native button, so it is in the tab order");
  assert.match(button, /type="button"/);
  assert.match(button, /aria-checked="false"/);

  const labelledBy = button.match(/aria-labelledby="([^"]+)"/)?.[1];
  assert.ok(labelledBy);
  assert.ok(
    html.includes(`id="${labelledBy}"`) && html.includes(CAPTURE_TOGGLE_LABEL),
    "the switch is named by its visible label",
  );

  assert.match(
    renderPanel(true),
    /role="switch"[^>]*aria-checked="true"|aria-checked="true"[^>]*role="switch"/,
  );
});

test("the copy stays in plain language: no engine names", () => {
  const html = renderPanel().toLowerCase();
  for (const jargon of [
    "adaptive ranking",
    "match quality",
    "intent extraction",
    "classifier",
    "otel",
  ]) {
    assert.ok(!html.includes(jargon), `no "${jargon}"`);
  }
});

test("the snippet carries the capture switch only when the customer opts in", () => {
  const props = {
    endpoint: "https://cloud.ratel.sh/api/v1/traces",
    serviceName: "support-copilot",
  };
  const off = renderToStaticMarkup(createElement(SdkQuickstart, props));
  const on = renderToStaticMarkup(createElement(SdkQuickstart, { ...props, captureContent: true }));
  assert.ok(!off.includes(QUICKSTART_CAPTURE_ENV));
  assert.ok(on.includes(QUICKSTART_CAPTURE_ENV));
});

test("the capture switch says the emitter decides, not the switch alone", () => {
  const html = renderPanel();
  assert.ok(html.includes(CAPTURE_TOGGLE_NOTE.replace(/'/g, "&#x27;")));
  // The framework that emits the spans has the last word (Eve: tracePolicy).
  assert.match(CAPTURE_TOGGLE_NOTE, /whatever emits/);
  assert.match(CAPTURE_TOGGLE_NOTE, /tracePolicy/);
  const button = html.match(/<button[^>]*role="switch"[^>]*>/)?.[0] ?? "";
  const describedBy = button.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(describedBy && html.includes(`id="${describedBy}"`), "the note describes the switch");
});

test("the Human tab offers NodeSDK, an existing OTel provider and curl", () => {
  const html = renderToStaticMarkup(
    createElement(SdkQuickstart, {
      endpoint: "https://cloud.ratel.sh/api/v1/traces",
      serviceName: "support-copilot",
    }),
  );
  for (const label of ["NodeSDK", "Existing OTel provider", "curl"]) {
    assert.ok(html.includes(`>${label}<`), `${label} is offered`);
  }
});

test("the agent prompt panel previews the prompt and copies it as the main action", () => {
  const html = renderToStaticMarkup(
    createElement(AgentPromptPanel, {
      projectName: "Support copilot",
      serviceName: "support-copilot",
      endpoint: "https://cloud.ratel.sh/api/v1/traces",
      tracesUrl: "https://cloud.ratel.sh/project/p_1/traces",
    }),
  );
  assert.match(html, /Copy this prompt for your agent/);
  assert.ok(html.includes("https://cloud.ratel.sh/api/v1/traces"), "the preview shows the prompt");
  assert.ok(!html.includes("rtl_"), "no key in the preview");
});
