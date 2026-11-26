import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addressLookup, loadAddressLookup, publicAddress } from "@/lib/ingest/geo/address";
import { DEFAULT_GEO_ATTRIBUTES } from "@/lib/ingest/geo/attributes";
import { loadReverseLookup } from "@/lib/ingest/geo/boundaries";
import {
  GEO_COUNTRY_KEY,
  GEO_REGION_KEY,
  type GeoLookups,
  locateSpans,
  MAX_GEO_LOOKUPS,
} from "@/lib/ingest/geo/locate";
import { mmdbFixture } from "@/lib/ingest/geo/mmdb-fixture";
import { parseGeoAttributes } from "@/lib/ingest/geo/parse-attributes";
import type { AttrMap, DecodedSpan } from "@/lib/ingest/otlp/types";

const DATABASE = mmdbFixture({
  "8.8.8.0/24": { country: { iso_code: "US" }, subdivisions: [{ names: { en: "California" } }] },
  "81.2.69.0/24": { country: { iso_code: "GB" }, subdivisions: [{ names: { en: "England" } }] },
  // What a database must never answer for.
  "10.0.0.0/8": { country: { iso_code: "FR" } },
});
const LOOKUPS: GeoLookups = { address: addressLookup(DATABASE), reverse: loadReverseLookup };

async function place(
  attributes: AttrMap,
  { resource = {}, lookups = LOOKUPS, names = DEFAULT_GEO_ATTRIBUTES } = {},
) {
  const span = { attributes: { ...attributes }, resourceAttributes: resource } as DecodedSpan;
  const { addressed } = await locateSpans([span], names, lookups);
  return [span.attributes[GEO_COUNTRY_KEY], span.attributes[GEO_REGION_KEY], addressed];
}

test("geo attributes: the codes as they are, the region with or without its country", async () => {
  const country = { "geo.country.iso_code": "us" };
  assert.deepEqual(await place(country), ["US", undefined, false]);
  const region = (code: string) => place({ ...country, "geo.region.iso_code": code });
  assert.deepEqual(await region("US-CA"), ["US", "US-CA", false]);
  assert.deepEqual(await region("ca"), ["US", "US-CA", false]);
  assert.deepEqual(await region("FR-75"), ["US", undefined, false]);
  assert.deepEqual(await place({ "geo.country.iso_code": "United States" }), [
    undefined,
    undefined,
    false,
  ]);
  assert.deepEqual(await place({}, { resource: { "geo.country.iso_code": "IT" } }), [
    "IT",
    undefined,
    false,
  ]);
});

test("coordinates: the country, and the state in the United States", async () => {
  const at = (lat: number | string, lon: number | string) =>
    place({ "geo.location.lat": lat, "geo.location.lon": lon });
  assert.deepEqual(await at(37.77, -122.42), ["US", "US-CA", false]);
  assert.deepEqual(await at("40.7128", "-74.006"), ["US", "US-NY", false]);
  assert.deepEqual(await at(45.46, 9.19), ["IT", undefined, false]);
  assert.deepEqual(await at(35.68, 139.69), ["JP", undefined, false]);
  // A harbor the simplified coast leaves in the sea.
  assert.deepEqual(await at(1.26, 103.82), ["SG", undefined, false]);
  // The sea, and no coordinates at all.
  assert.deepEqual(await at(0, -30), [undefined, undefined, false]);
  assert.deepEqual(await at(200, 9), [undefined, undefined, false]);
  assert.deepEqual(await at("", ""), [undefined, undefined, false]);
});

test("an IP address: the country and, in the United States, the state", async () => {
  const at = (address: string) => place({ "client.address": address });
  assert.deepEqual(await at("8.8.8.8"), ["US", "US-CA", true]);
  assert.deepEqual(await at("8.8.8.8:443"), ["US", "US-CA", true]);
  assert.deepEqual(await at("::ffff:8.8.8.8"), ["US", "US-CA", true]);
  assert.deepEqual(await at("81.2.69.160"), ["GB", undefined, true]);
  assert.deepEqual(await at("9.9.9.9"), [undefined, undefined, true]);
});

test("F445-5: an address in a list, or in any other value of the configured key, counts as an address", async () => {
  const list: AttrMap = { "client.address": ["8.8.8.8"] };
  const addressed = async (attributes: AttrMap, options = {}) =>
    (await place(attributes, options))[2];
  assert.equal(await addressed(list), true);
  assert.equal(await addressed({}, { resource: list }), true);
  const forwarded = "http.request.header.x-forwarded-for";
  const names = { ...DEFAULT_GEO_ATTRIBUTES, address: forwarded };
  assert.equal(await addressed({ [forwarded]: ["8.8.8.8", "10.0.0.1"] }, { names }), true);
  assert.equal(await addressed({ "client.address": { ip: "8.8.8.8" } }), true);
  assert.equal(await addressed({ "client.address": 134744072 }), true);
  // An empty value of the span does not hide its resource's.
  assert.equal(await addressed({ "client.address": "" }, { resource: list }), true);
  for (const empty of [null, "", []])
    assert.equal(await addressed({ "client.address": empty }), false, JSON.stringify(empty));
});

test("a private or reserved address, or no address, resolves to nothing", async () => {
  for (const address of [
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.1.1",
    "100.64.0.1",
    "203.0.113.9",
    "224.0.0.1",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:10.0.0.1",
    "gateway.local",
  ]) {
    assert.equal(publicAddress(address), null, address);
    assert.deepEqual(await place({ "client.address": address }), [undefined, undefined, true]);
  }
  assert.equal(publicAddress("[2001:4860:4860::8888]:53"), "2001:4860:4860::8888");
});

test("the code wins over the coordinates, and they over the address", async () => {
  const address = { "client.address": "8.8.8.8" };
  const milan = { "geo.location.lat": 45.46, "geo.location.lon": 9.19 };
  assert.deepEqual(await place({ ...address, ...milan }), ["IT", undefined, true]);
  assert.deepEqual(await place({ ...address, ...milan, "geo.country.iso_code": "FR" }), [
    "FR",
    undefined,
    true,
  ]);
  // The sea says nothing, so the address may.
  assert.deepEqual(await place({ ...address, "geo.location.lat": 0, "geo.location.lon": -30 }), [
    "US",
    "US-CA",
    true,
  ]);
});

test("without a database file addresses are skipped and geo attributes still work", async () => {
  const lookups = { ...LOOKUPS, address: await loadAddressLookup("/nowhere/geo.mmdb") };
  assert.equal(lookups.address, null);
  assert.deepEqual(await place({ "client.address": "8.8.8.8" }, { lookups }), [
    undefined,
    undefined,
    true,
  ]);
  assert.deepEqual(await place({ "geo.country.iso_code": "US" }, { lookups }), [
    "US",
    undefined,
    false,
  ]);
});

test("a project's own names are read instead, and what the emitter calls ours is not believed", async () => {
  const names = { ...DEFAULT_GEO_ATTRIBUTES, country: "app.country" };
  assert.deepEqual(await place({ "app.country": "DE", "geo.country.iso_code": "FR" }, { names }), [
    "DE",
    undefined,
    false,
  ]);
  assert.deepEqual(await place({ [GEO_COUNTRY_KEY]: "8.8.8.8" }), [undefined, undefined, false]);
});

test("a newer database file is taken", async () => {
  const folder = await mkdtemp(join(tmpdir(), "geo-"));
  const path = join(folder, "geo.mmdb");
  try {
    assert.equal(await loadAddressLookup(path, 0), null);
    await writeFile(path, DATABASE);
    assert.equal(await loadAddressLookup(path, 1), null);
    const lookup = await loadAddressLookup(path, 120_000);
    assert.deepEqual(lookup?.("8.8.8.8"), { country: "US", region: "US-CA" });
  } finally {
    await rm(folder, { recursive: true });
  }
});

test("an address or a coordinate cannot be read from an attribute that spans store", () => {
  const parse = (change: object) => parseGeoAttributes({ ...DEFAULT_GEO_ATTRIBUTES, ...change });
  assert.ok(parse({}).ok);
  assert.ok(parse({ country: "ratel.country", address: "app.ip" }).ok);
  for (const change of [
    { address: "ratel.client_ip" },
    { address: "gen_ai.user.ip" },
    { address: "server.address" },
    { latitude: "ratel.lat" },
  ]) {
    const parsed = parse(change);
    assert.ok(!parsed.ok && /must not be stored/.test(parsed.error), JSON.stringify(change));
  }
  for (const change of [{ country: " " }, { extra: "x" }]) assert.ok(!parse(change).ok);
});

test("F445-11: many distinct places never block the process, and a batch looks up a bounded number", async () => {
  let calls = 0;
  const slow: GeoLookups = {
    address: null,
    reverse: async () => () => {
      calls += 1;
      const until = performance.now() + 1;
      while (performance.now() < until);
      return { country: "IT", region: null };
    },
  };
  const spans = Array.from(
    { length: 2_000 },
    (_, i) =>
      ({
        attributes: { "geo.location.lat": 45 + i / 10_000, "geo.location.lon": 9 },
        resourceAttributes: {},
      }) as unknown as DecodedSpan,
  );
  spans.push({
    attributes: { "geo.country.iso_code": "FR" },
    resourceAttributes: {},
  } as unknown as DecodedSpan);
  let longest = 0;
  let last = performance.now();
  let beating = true;
  const beat = () => {
    const at = performance.now();
    longest = Math.max(longest, at - last);
    last = at;
    if (beating) setImmediate(beat);
  };
  setImmediate(beat);
  await locateSpans(spans, DEFAULT_GEO_ATTRIBUTES, slow);
  beating = false;
  longest = Math.max(longest, performance.now() - last);
  assert.ok(longest < 100, `the event loop waited ${Math.round(longest)} ms`);
  assert.equal(calls, MAX_GEO_LOOKUPS);
  assert.equal(spans[MAX_GEO_LOOKUPS - 1].attributes[GEO_COUNTRY_KEY], "IT");
  assert.equal(spans[MAX_GEO_LOOKUPS].attributes[GEO_COUNTRY_KEY], undefined);
  assert.equal(spans[2_000].attributes[GEO_COUNTRY_KEY], "FR", "codes need no lookup");
});
