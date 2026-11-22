// First: the setup guide's dot loader imports a stylesheet, which node loads as nothing once this has run.
import "@/lib/views/tasks/test-support";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SetupGuide } from "@/components/console/home/SetupGuide";
import { SdkQuickstart as DashboardSdkQuickstart } from "@/components/console/onboarding/SdkQuickstart";
import { SdkQuickstart as SettingsSdkQuickstart } from "@/components/console/settings/SdkQuickstart";

/** RC-995: the app's three SDK setup surfaces ask for service.version only when the server says so. */

const BASE = { endpoint: "https://cloud.example.test/v1/traces", serviceName: "support-bot" };
const GUIDANCE = /service\.version to the commit sha of the deploy/;

const SURFACES = [
  {
    name: "Settings › API keys",
    render: (props: { deployVersion?: boolean }) =>
      createElement(SettingsSdkQuickstart, { ...BASE, ...props }),
  },
  {
    name: "Overview setup guide",
    render: (props: { deployVersion?: boolean }) =>
      createElement(SetupGuide, { ...BASE, root: "/project/p1", ...props }),
  },
  {
    name: "dashboard quickstart",
    render: (props: { deployVersion?: boolean }) =>
      createElement(DashboardSdkQuickstart, { ...BASE, ...props }),
  },
];

for (const surface of SURFACES) {
  test(`${surface.name}: flag on renders the service.version = commit sha guidance`, () => {
    const html = renderToStaticMarkup(surface.render({ deployVersion: true }));
    assert.match(html, GUIDANCE);
    assert.match(html, /OTEL_RESOURCE_ATTRIBUTES=service\.version=\$GITHUB_SHA/);
  });

  test(`${surface.name}: flag off renders exactly as without the prop`, () => {
    const off = renderToStaticMarkup(surface.render({ deployVersion: false }));
    assert.equal(off, renderToStaticMarkup(surface.render({})));
    assert.doesNotMatch(off, GUIDANCE);
  });
}
