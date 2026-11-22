import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { countryLabel } from "@/components/console/clients/labels";
import {
  ALPHA2_TO_NUMERIC,
  alpha2ToNumeric,
  canonicalAlpha2,
  featureAlpha2,
} from "./country-codes";

/** Region codes Intl names that ISO 3166-1 does not assign to a country (and Kosovo, mapped by name). */
const NOT_ISO_COUNTRIES = new Set([
  "AC",
  "CP",
  "CQ",
  "DG",
  "EA",
  "EU",
  "EZ",
  "IC",
  "QO",
  "TA",
  "UN",
  "XA",
  "XB",
  "XK",
  "ZZ",
]);

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

test("every assigned ISO code has a distinct three-digit numeric code", () => {
  const entries = Object.entries(ALPHA2_TO_NUMERIC);
  assert.equal(entries.length, 249);
  for (const [alpha2, numeric] of entries) {
    assert.match(alpha2, /^[A-Z]{2}$/);
    assert.match(numeric, /^\d{3}$/, alpha2);
  }
  assert.equal(
    new Set(entries.map(([, numeric]) => numeric)).size,
    entries.length,
    "numeric codes are unique",
  );
});

test("every country countryLabel names maps to a numeric code", () => {
  const named = LETTERS.flatMap((a) => LETTERS.map((b) => `${a}${b}`)).filter(
    (code) => countryLabel(code) !== code,
  );
  const missing = named.filter(
    (code) => !NOT_ISO_COUNTRIES.has(code) && alpha2ToNumeric(code) === null,
  );
  assert.deepEqual(missing, []);
  assert.ok(named.length >= 249);
});

test("alpha2ToNumeric reads any case and refuses unassigned codes", () => {
  assert.equal(alpha2ToNumeric("IT"), "380");
  assert.equal(alpha2ToNumeric("us"), "840");
  assert.equal(alpha2ToNumeric("AF"), "004");
  assert.equal(alpha2ToNumeric("UK"), "826", "a withdrawn code reads as its successor");
  assert.equal(alpha2ToNumeric("XK"), null);
  assert.equal(alpha2ToNumeric("??"), null);
});

test("canonicalAlpha2 is the join key: upper case, withdrawn codes as their successor", () => {
  assert.equal(canonicalAlpha2("it"), "IT");
  assert.equal(canonicalAlpha2("UK"), "GB");
  assert.equal(canonicalAlpha2("ZR"), "CD");
  assert.equal(canonicalAlpha2("xk"), "XK");
  assert.equal(canonicalAlpha2("??"), "??");
});

test("featureAlpha2 names every country world-atlas draws", () => {
  const require = createRequire(import.meta.url);
  const atlas = require("world-atlas/countries-110m.json") as {
    objects: { countries: { geometries: { id?: string; properties: { name: string } }[] } };
  };
  const geometries = atlas.objects.countries.geometries;
  const unnamed = geometries
    .filter((g) => featureAlpha2(g.id, g.properties.name) === null)
    .map((g) => g.properties.name);
  assert.deepEqual(
    unnamed,
    ["N. Cyprus", "Somaliland"],
    "only the two territories without a code stay unnamed",
  );
  assert.equal(featureAlpha2(undefined, "Kosovo"), "XK");
  assert.equal(featureAlpha2("380", "Italy"), "IT");
  assert.equal(featureAlpha2(4, "Afghanistan"), "AF");
});
