import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  createGeoLoader,
  fakeGeoLookup,
  isPublicAddress,
  mmdbGeoLookup,
  NO_GEO,
  publicCountryOf,
} from "./geo";

const TEST_DB = join(process.cwd(), "lib/ingest/otlp/__fixtures__/geo/GeoIP2-Country-Test.mmdb");

test("the mmdb adapter reads the ISO country code of an address", () => {
  const geo = mmdbGeoLookup(readFileSync(TEST_DB));
  assert.equal(geo.countryOf("81.2.69.160"), "GB");
  assert.equal(geo.countryOf("216.160.83.56"), "US");
  assert.equal(geo.countryOf("2001:218::1"), "JP");
  assert.equal(geo.countryOf("8.8.8.8"), null, "an address the file does not know");
});

test("private, loopback, link-local, shared, documentation, multicast and reserved addresses are not public", () => {
  for (const ip of [
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.7",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:10.0.0.1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["81.2.69.160", "8.8.8.8", "2001:218::1", "::ffff:81.2.69.160"])
    assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of ["", "not-an-ip", "999.1.1.1", "81.2.69.160:443"])
    assert.equal(isPublicAddress(ip), false, `invalid ${ip}`);
});

test("publicCountryOf looks up public addresses only, and once per address", () => {
  const asked: string[] = [];
  const geo = fakeGeoLookup({ "81.2.69.160": "GB", "10.0.0.1": "XX" });
  const countryOf = publicCountryOf({ countryOf: (ip) => (asked.push(ip), geo.countryOf(ip)) });
  assert.equal(countryOf("81.2.69.160"), "GB");
  assert.equal(countryOf("81.2.69.160"), "GB");
  assert.equal(countryOf("::ffff:81.2.69.160"), "GB", "an IPv4-mapped address is its IPv4 address");
  assert.equal(countryOf("10.0.0.1"), null, "a private address is never looked up");
  assert.equal(countryOf(null), null);
  assert.deepEqual(asked, ["81.2.69.160"]);
});

test("a missing file logs one time, gives no geo, and is not read again", () => {
  const logged: string[] = [];
  let reads = 0;
  const load = createGeoLoader({
    path: "/nowhere/dbip-country-lite.mmdb",
    readFile: () => {
      reads += 1;
      throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    },
    logWarn: (message) => logged.push(message),
  });
  assert.equal(load(), NO_GEO);
  assert.equal(load(), NO_GEO);
  assert.equal(load().countryOf("81.2.69.160"), null);
  assert.deepEqual(logged, ["geo database unavailable, client countries stay null"]);
  assert.equal(reads, 1);
});

test("an unset path and an unreadable file log one time too", () => {
  const unset: string[] = [];
  const noPath = createGeoLoader({
    path: undefined,
    readFile: () => assert.fail("not read"),
    logWarn: (m) => unset.push(m),
  });
  noPath();
  noPath();
  assert.equal(unset.length, 1);

  const corrupt: string[] = [];
  const bad = createGeoLoader({
    path: "/x.mmdb",
    readFile: () => Buffer.from("not an mmdb"),
    logWarn: (m) => corrupt.push(m),
  });
  assert.equal(bad(), NO_GEO);
  bad();
  assert.equal(corrupt.length, 1);
});

test("a readable file is loaded one time per process", () => {
  let reads = 0;
  const load = createGeoLoader({
    path: TEST_DB,
    readFile: (path) => {
      reads += 1;
      return readFileSync(path);
    },
    logWarn: () => assert.fail("no log"),
  });
  assert.equal(load().countryOf("89.160.20.112"), "SE");
  assert.equal(load().countryOf("81.2.69.160"), "GB");
  assert.equal(reads, 1);
});
