import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FixSource } from "@/components/console/lineage/FixSource";
import { ShipmentTrail } from "@/components/console/lineage/ShipmentsTable";
import { LineageSteps, LineageTrail, SourceLink } from "@/components/console/lineage/SourceLink";
import { StageSpineProvider } from "@/components/console/lineage/stage-spine-context";
import { evalRef, fixRef, insightRef, shipmentRef, traceRef, withHref } from "./refs";

const P = "p1";

test("SourceLink says where an object came from and opens it", () => {
  const html = renderToStaticMarkup(
    createElement(SourceLink, { source: traceRef("4f2a91d0c3b2e1f0a9c07e"), projectId: P }),
  );
  assert.match(html, /data-lineage-source="trace"/);
  assert.match(html, />From</);
  assert.match(html, /href="\/project\/p1\/traces\/4f2a91d0c3b2e1f0a9c07e"/);
  assert.match(html, /font-mono[^>]*>4f2a91d…a9c07e</, "the id in mono, cut in the middle");
  assert.match(html, /title="4f2a91d0c3b2e1f0a9c07e"/, "the whole id on hover");

  const insight = renderToStaticMarkup(
    createElement(SourceLink, {
      source: insightRef("s1", "Wrong tool keeps showing up"),
      projectId: P,
    }),
  );
  assert.match(insight, /href="\/project\/p1\/health#signal-s1"/);
  assert.match(insight, />Wrong tool keeps showing up</);

  assert.equal(
    renderToStaticMarkup(createElement(SourceLink, { source: null, projectId: P })),
    "",
    "nothing to say, nothing shown",
  );
  assert.match(
    renderToStaticMarkup(
      createElement(SourceLink, { source: null, projectId: P, empty: "Not linked to an insight" }),
    ),
    />Not linked to an insight</,
  );
});

test("LineageTrail walks back oldest first and does not link the object itself", () => {
  const html = renderToStaticMarkup(
    createElement(LineageTrail, {
      chain: [
        traceRef("t1"),
        insightRef("s1", "Wrong tool"),
        fixRef("issue:s1", "Hide create_task"),
        shipmentRef("rewrite:r1", "Shipped"),
      ],
      projectId: P,
    }),
  );
  assert.match(html, /aria-label="Where this came from"/);
  const kinds = [...html.matchAll(/data-lineage-kind="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(kinds, ["trace", "insight", "fix", "shipment"]);
  assert.equal((html.match(/<a /g) ?? []).length, 3, "the last step is where you are");
  assert.match(html, /aria-current="page"/);
  assert.equal(
    renderToStaticMarkup(createElement(LineageTrail, { chain: [traceRef("t1")], projectId: P })),
    "",
  );
});

test("a fix's source shows only with the stage spine on", () => {
  const fix = {
    issues: [],
    intent: { id: "t1", label: "Book a flight", href: "/project/p1/intents?peek=t1" },
    subject: { tools: [], tasks: [], topics: [] },
  };
  assert.equal(
    renderToStaticMarkup(createElement(FixSource, { projectId: P, fix })),
    "",
    "off by default",
  );
  const on = renderToStaticMarkup(
    createElement(
      StageSpineProvider,
      { enabled: true },
      createElement(FixSource, { projectId: P, fix }),
    ),
  );
  assert.match(on, /data-lineage-source="intent"/);
  assert.match(on, />Book a flight</);
  const none = renderToStaticMarkup(
    createElement(
      StageSpineProvider,
      { enabled: true },
      createElement(FixSource, { projectId: P, fix: { ...fix, intent: undefined } }),
    ),
  );
  assert.match(none, />Not linked to an insight</);
});

test("a shipment's trail lists every step with its stage, each opening its page but the shipment itself (RC-71)", () => {
  const chain = [
    traceRef("t1"),
    insightRef("s1", "Tool keeps failing"),
    fixRef("craft:c1", "Merge 2 tools"),
    evalRef(P, "e1", "craft:c1", "Eval: Merge 2 tools"),
    shipmentRef("sh1", "Merge 2 tools shipped in v2.5.0"),
  ].map((ref) => withHref(ref, P));
  const html = renderToStaticMarkup(createElement(LineageSteps, { chain, projectId: P }));
  assert.deepEqual(
    [...html.matchAll(/data-trail-step="(\w+)"/g)].map((m) => m[1]),
    ["trace", "insight", "fix", "eval", "shipment"],
  );
  assert.deepEqual(
    [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]),
    [
      "/project/p1/traces/t1",
      "/project/p1/health#signal-s1",
      "/project/p1/improvement/fixes?peek=craft%3Ac1",
      "/project/p1/improvement/fixes/craft%3Ac1/eval",
    ],
    "every step links but the last",
  );
  assert.match(html, />Monitor</);
  assert.match(html, />Ship</);
  assert.match(html, /aria-current="page"/);
  assert.doesNotMatch(
    html,
    /text-\[(9|10|11)px\]|uppercase|#[0-9a-f]{6}/i,
    "tokens only, nothing under 12 px",
  );

  const alone = renderToStaticMarkup(
    createElement(ShipmentTrail, { trail: [shipmentRef("sh2", "Fix shipped")], projectId: P }),
  );
  assert.match(alone, /No fix was recorded/);
});
