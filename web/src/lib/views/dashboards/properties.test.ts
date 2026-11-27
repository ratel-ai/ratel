import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dimensionOfValue,
  dimensionValue,
  NO_PROPERTIES,
  type PropertyChoices,
  propertyBlock,
  propertyOfValue,
  propertyOptions,
  propertySettingsHref,
} from "./properties";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const CHOICES: PropertyChoices = {
  indexed: [{ name: "plan", values: [{ value: "pro", count: 3 }] }],
  detected: [
    { name: "tenant id", source: "user" },
    { name: "release", source: "standard" },
  ],
  entitled: true,
  upgradeHref: "/org/acme/billing",
};

test("an indexed property can be picked; a detected one says it must be indexed, with the link to it", () => {
  assert.equal(propertyBlock(PROJECT, CHOICES, "plan"), null);
  const block = propertyBlock(PROJECT, CHOICES, "tenant id");
  assert.match(block?.message ?? "", /must|not indexed/);
  assert.match(block?.message ?? "", /must be indexed first/);
  assert.deepEqual(block?.link, {
    href: `/project/${PROJECT}/settings?property=tenant%20id#trace-properties`,
    label: "Index it in project settings",
  });
  assert.equal(block?.link.href, propertySettingsHref(PROJECT, "tenant id"));
});

test("without the entitlement a property of the project's own needs a paid plan, with the upgrade link", () => {
  const off = { ...CHOICES, entitled: false };
  assert.deepEqual(propertyBlock(PROJECT, off, "tenant id"), {
    name: "tenant id",
    message: "Indexing your own properties, such as tenant id, needs a paid plan.",
    link: { href: "/org/acme/billing", label: "Upgrade" },
  });
  // A standard property is indexed on every plan.
  assert.match(propertyBlock(PROJECT, off, "release")?.link.label ?? "", /Index it/);
  // No billing of its own: the section of the properties instead.
  assert.equal(
    propertyBlock(PROJECT, { ...off, upgradeHref: null }, "tenant id")?.link.href,
    propertySettingsHref(PROJECT, "tenant id"),
  );
  assert.ok(NO_PROPERTIES.entitled);
});

test("a dropdown value names a built-in field or a property, and reads back", () => {
  for (const dimension of ["model", { property: "plan" }, { property: "property:x" }] as const) {
    assert.deepEqual(dimensionOfValue(dimensionValue(dimension)), dimension);
  }
  assert.equal(propertyOfValue(dimensionValue({ property: "plan" })), "plan");
  assert.equal(propertyOfValue("model"), undefined);
});

test("the options list the indexed properties, then the detected ones off, under one heading", () => {
  assert.deepEqual(propertyOptions(CHOICES, ["property:release"]), [
    { value: "property:plan", label: "plan", group: "Trace properties" },
    {
      value: "property:tenant id",
      label: "tenant id",
      group: "Trace properties",
      muted: true,
      detail: "not indexed",
    },
  ]);
  assert.deepEqual(propertyOptions(NO_PROPERTIES), []);
});
