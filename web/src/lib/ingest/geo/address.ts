import { readFile, stat } from "node:fs/promises";
import { BlockList, isIP, isIPv4 } from "node:net";
import { Reader, type Response } from "mmdb-lib";
import { getConfig } from "@/config";
import { countryCode, type GeoCodes, regionOfName } from "@/lib/ingest/geo/codes";
import { getLogger } from "@/lib/platform/logger";

/**
 * An IP address to a place, with the DB-IP Lite file of the deployment. The address is looked up and
 * let go: it is never stored and never logged.
 */

export type AddressLookup = (address: string) => GeoCodes | null;

/** How long an absent or unreadable file is taken as that. */
const RECHECK_MS = 60_000;
const logger = getLogger("ingest/geo");

let loaded: { path: string; lookup: AddressLookup | null; at: number; mtimeMs: number } | undefined;

/** The deployment's lookup, or null without a database file. A newer file is taken within a minute. */
export async function loadAddressLookup(
  path: string | undefined = getConfig().ingest.geoDatabasePath,
  now: number = Date.now(),
): Promise<AddressLookup | null> {
  if (!path) return null;
  if (loaded?.path === path && now - loaded.at < RECHECK_MS) return loaded.lookup;
  try {
    const { mtimeMs } = await stat(path);
    if (loaded?.path === path && loaded.lookup && loaded.mtimeMs === mtimeMs) {
      loaded.at = now;
      return loaded.lookup;
    }
    loaded = { path, lookup: addressLookup(await readFile(path)), at: now, mtimeMs };
  } catch (err) {
    logger.warn({ err }, "geo database not read");
    loaded = { path, lookup: null, at: now, mtimeMs: 0 };
  }
  return loaded.lookup;
}

/** Whether addresses can be resolved here. */
export async function addressResolution(): Promise<boolean> {
  const path = getConfig().ingest.geoDatabasePath;
  if (!path) return false;
  // Not the file itself: the process that only draws the widget does not need it in memory.
  return stat(path).then(
    (file) => file.isFile(),
    () => false,
  );
}

export function addressLookup(database: Buffer): AddressLookup {
  const reader = new Reader<Response>(database);
  return (raw) => {
    const address = publicAddress(raw);
    if (!address) return null;
    const record = reader.get(address) as {
      country?: { iso_code?: string };
      subdivisions?: { names?: { en?: string } }[];
    } | null;
    const country = countryCode(record?.country?.iso_code);
    if (!country) return null;
    return { country, region: regionOfName(country, record?.subdivisions?.[0]?.names?.en ?? "") };
  };
}

/** The address without a port or brackets; null when it is none, or not one of the public internet. */
export function publicAddress(raw: string): string | null {
  const address = bare(raw.trim());
  const family = isIP(address);
  if (family === 0) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const plain = mapped ?? address;
  return RESERVED.check(plain, isIPv4(plain) ? "ipv4" : "ipv6") ? null : plain;
}

function bare(text: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
  if (bracketed) return bracketed[1];
  const ported = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(text);
  return ported ? ported[1] : text;
}

const RESERVED = reserved();

/** The IANA special-purpose registries: no place of the public internet. */
function reserved(): BlockList {
  const list = new BlockList();
  const ipv4: [string, number][] = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 3],
  ];
  const ipv6: [string, number][] = [
    ["::", 128],
    ["::1", 128],
    ["100::", 64],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ];
  for (const [net, prefix] of ipv4) list.addSubnet(net, prefix, "ipv4");
  for (const [net, prefix] of ipv6) list.addSubnet(net, prefix, "ipv6");
  return list;
}
