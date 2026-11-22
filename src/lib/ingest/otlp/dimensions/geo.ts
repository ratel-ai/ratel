import { readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { type CountryResponse, Reader } from "mmdb-lib";
import { getLogger } from "@/lib/platform/logger";

/**
 * The country of a caller's IP (RC-774), from a local mmdb file: the DB-IP
 * IP-to-Country Lite database the image ships (infra/README.md). No address
 * ever leaves the process.
 *
 * `GeoLookup` is the port: `mmdbGeoLookup` reads the file, `fakeGeoLookup` is
 * for tests. `publicCountryOf` wraps either one for a batch: it skips
 * private, loopback and reserved addresses and asks each address one time.
 * `processGeoLookup` loads the file one time per process; a missing or
 * unreadable file logs one time and gives no geo, and ingest goes on.
 */

export interface GeoLookup {
  /** The ISO 3166-1 alpha-2 code of the address, or null when the file does not know it. */
  countryOf: (ip: string) => string | null;
}

/** The env var that names the mmdb file. The image sets it (apps/web/Dockerfile). */
export const GEO_DB_PATH_ENV = "GEO_COUNTRY_MMDB_PATH";

/** No geo: every address gives null. */
export const NO_GEO: GeoLookup = Object.freeze({ countryOf: () => null });

const ISO_COUNTRY = /^[A-Z]{2}$/;
const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** Ranges with no geo: private, loopback, link-local, shared, documentation, multicast and reserved. */
const NOT_PUBLIC = (() => {
  const list = new BlockList();
  const v4: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  const v6: Array<[string, number]> = [
    ["::", 128],
    ["::1", 128],
    ["100::", 64],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ];
  for (const [net, prefix] of v4) list.addSubnet(net, prefix, "ipv4");
  for (const [net, prefix] of v6) list.addSubnet(net, prefix, "ipv6");
  return list;
})();

/** A lookup over the bytes of an mmdb file with a GeoIP2-Country record shape (`country.iso_code`). */
export function mmdbGeoLookup(file: Buffer): GeoLookup {
  const reader = new Reader<CountryResponse>(file);
  return {
    countryOf(ip) {
      const code = reader.get(ip)?.country?.iso_code;
      return code && ISO_COUNTRY.test(code) ? code : null;
    },
  };
}

/** A lookup over a fixed table, for tests. */
export function fakeGeoLookup(table: Readonly<Record<string, string>>): GeoLookup {
  return { countryOf: (ip) => table[ip] ?? null };
}

/** True for a valid IP outside every private, loopback and reserved range. An IPv4-mapped IPv6 address is its IPv4 address. */
export function isPublicAddress(ip: string): boolean {
  const address = unmapped(ip);
  const family = isIP(address);
  if (family === 0) return false;
  return !NOT_PUBLIC.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** The lookup for one batch: public addresses only, each asked one time. */
export function publicCountryOf(geo: GeoLookup): (ip: string | null) => string | null {
  const cache = new Map<string, string | null>();
  return (ip) => {
    if (!ip || !isPublicAddress(ip)) return null;
    const address = unmapped(ip);
    if (!cache.has(address)) cache.set(address, geo.countryOf(address));
    return cache.get(address)!;
  };
}

export interface GeoLoaderOptions {
  path: string | undefined;
  readFile: (path: string) => Buffer;
  logWarn: (message: string, context: Record<string, unknown>) => void;
}

/** A getter that loads the file on its first call and returns the same lookup after. A failure logs one time. */
export function createGeoLoader({ path, readFile, logWarn }: GeoLoaderOptions): () => GeoLookup {
  let loaded: GeoLookup | undefined;
  return () => {
    if (loaded) return loaded;
    try {
      if (!path) throw new Error(`${GEO_DB_PATH_ENV} is not set`);
      loaded = mmdbGeoLookup(readFile(path));
    } catch (err) {
      logWarn("geo database unavailable, client countries stay null", {
        path: path ?? null,
        error: err instanceof Error ? err.message : String(err),
      });
      loaded = NO_GEO;
    }
    return loaded;
  };
}

/** The process's lookup, from the file `GEO_COUNTRY_MMDB_PATH` names. */
export const processGeoLookup: () => GeoLookup = createGeoLoader({
  path: process.env[GEO_DB_PATH_ENV],
  readFile: (path) => readFileSync(path),
  logWarn: (message, context) => getLogger("otlp/geo").warn(context, message),
});

function unmapped(ip: string): string {
  return ip.trim().match(IPV4_MAPPED)?.[1] ?? ip.trim();
}
