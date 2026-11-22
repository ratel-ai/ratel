import protobuf from "protobufjs";
import { experimentalFeatureEnabled } from "@/lib/platform/experimental-features";
import type { OtlpTransport } from "./http";
import logsDescriptor from "./proto/otlp-logs.descriptor.json";
import traceDescriptor from "./proto/otlp-trace.descriptor.json";

/**
 * Ingest keeps no IP address of the sender. OTel SDKs and collectors can put
 * one on a resource, scope, span, event, link or log record (`host.ip`,
 * `client.address`, ...). The normalized tables keep only an allowlist, which
 * never includes these keys, but raw capture (RC-405) stores the body as sent.
 * So every ingest route removes these keys from the body before anything reads
 * it, nested `kvlistValue` lists included. `server.address` stays: on an
 * exporter's span it names the remote server, not the sender.
 *
 * Switch: `FF_INGEST_STRIP_CLIENT_ADDRESS`, one value for the deployment, read
 * from the environment and off by default (in the open-source edition also
 * `RATEL_EXPERIMENTAL_FEATURES`). Upstream (ratel-cloud #559) has it as the boot
 * kill switch `cloud-ingest-strip-client-address`, on by default.
 */

export type OtlpSignal = "traces" | "logs";

export interface StripResult {
  /** The body to decode and store: the same bytes when nothing was removed. */
  bytes: Uint8Array;
  stripped: boolean;
}

export const CLIENT_ADDRESS_STRIP_FLAG = "FF_INGEST_STRIP_CLIENT_ADDRESS" as const;

/** Stable and legacy OTel attribute keys whose value is an IP address of the sender or its peer. */
export const CLIENT_ADDRESS_KEYS: ReadonlySet<string> = new Set([
  "client.address",
  "client.ip",
  "client.socket.address",
  "source.address",
  "host.ip",
  "network.peer.address",
  "network.local.address",
  "http.client_ip",
  "net.peer.ip",
  "net.host.ip",
  "net.sock.peer.addr",
  "net.sock.host.addr",
]);

const REQUEST_TYPES: Record<OtlpSignal, protobuf.Type> = {
  traces: protobuf.Root.fromJSON(traceDescriptor as protobuf.INamespace).lookupType(
    "ratel.otlp.ExportTraceServiceRequest",
  ),
  logs: protobuf.Root.fromJSON(logsDescriptor as protobuf.INamespace).lookupType(
    "ratel.otlp.ExportLogsServiceRequest",
  ),
};

/**
 * Captured request headers that carry the caller's address:
 * `http.request.header.<name>` (OTel lowercases the name; older instrumentations
 * write `_` for `-`), its value a string or a string array, and the flattened
 * `http.request.header.<name>.<index>` form some exporters write for the array.
 */
const FORWARDING_HEADER_KEY =
  /^http\.request\.header\.(?:x[-_]forwarded[-_]for|x[-_]real[-_]ip|forwarded|true[-_]client[-_]ip|cf[-_]connecting[-_]ip)(?:\.\d+)?$/i;

/**
 * One case-insensitive pass over the body for any fragment a client address key
 * contains. Latin-1 keeps every byte one character, so a match lines up with
 * the bytes whatever the encoding.
 */
const KEY_SCAN = new RegExp(
  [...CLIENT_ADDRESS_KEYS, "http.request.header."]
    .map((key) => key.replace(/\./g, "\\."))
    .join("|"),
  "i",
);

/** Whether an attribute key carries an IP address of the sender or its peer, in any letter case. */
export function isClientAddressKey(key: string): boolean {
  return CLIENT_ADDRESS_KEYS.has(key.toLowerCase()) || FORWARDING_HEADER_KEY.test(key);
}

/** Whether the strip is on for this deployment. Reads the environment; never throws. */
export function clientAddressStripEnabled(
  env: Record<string, string | undefined> = process.env,
  edition?: string,
): boolean {
  return experimentalFeatureEnabled(CLIENT_ADDRESS_STRIP_FLAG, env, edition);
}

/**
 * The export without its client address attributes. A body that names none of
 * the keys is returned as is, without a parse. A body that does not parse is
 * returned as is too: the decoder refuses it next.
 */
export function stripClientAddresses(
  signal: OtlpSignal,
  transport: OtlpTransport,
  body: Uint8Array,
  enabled: boolean = clientAddressStripEnabled(),
): StripResult {
  const unchanged = { bytes: body, stripped: false };
  if (!enabled || !mentionsClientAddressKey(body)) return unchanged;
  try {
    if (transport === "json") {
      const request: unknown = JSON.parse(Buffer.from(body).toString("utf8"));
      if (!removeClientAddressAttributes(request)) return unchanged;
      return { bytes: new TextEncoder().encode(JSON.stringify(request)), stripped: true };
    }
    const type = REQUEST_TYPES[signal];
    const message = type.decode(body);
    if (!removeClientAddressAttributes(message)) return unchanged;
    return { bytes: type.encode(message).finish(), stripped: true };
  } catch {
    return unchanged;
  }
}

function mentionsClientAddressKey(body: Uint8Array): boolean {
  return KEY_SCAN.test(
    Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("latin1"),
  );
}

/**
 * Removes the keys from every `attributes` list and every `kvlistValue.values`
 * list in the tree, in place, at any depth. True when one was removed.
 */
function removeClientAddressAttributes(node: unknown): boolean {
  if (Array.isArray(node)) {
    let removed = false;
    for (const child of node) removed = removeClientAddressAttributes(child) || removed;
    return removed;
  }
  if (node === null || typeof node !== "object") return false;
  let removed = false;
  const record = node as Record<string, unknown>;
  for (const [field, child] of Object.entries(record)) {
    if ((field === "attributes" || field === "values") && Array.isArray(child)) {
      const kept = child.filter((kv) => !isClientAddressKeyValue(kv));
      if (kept.length !== child.length) {
        record[field] = kept;
        removed = true;
      }
      removed = removeClientAddressAttributes(kept) || removed;
      continue;
    }
    removed = removeClientAddressAttributes(child) || removed;
  }
  return removed;
}

/** A `KeyValue` with a client address key. An `arrayValue` element has no key and is never one. */
function isClientAddressKeyValue(kv: unknown): boolean {
  const key = (kv as { key?: unknown } | null)?.key;
  return typeof key === "string" && isClientAddressKey(key);
}
