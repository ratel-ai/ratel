import { isContentFreeAttributeKey } from "@/lib/ingest/otlp/span-rows";
import type {
  AttrMap,
  AttrValue,
  DecodedEvent,
  RawAnyValue,
  RawKeyValue,
} from "@/lib/ingest/otlp/types";

/**
 * What the raw view and the OTLP download show of the attributes a customer
 * sent (RC-454). Credentials never leave: credential-like keys (auth headers,
 * cookies, API keys, tokens, passwords, the process command line) become
 * `REDACTED`, and so do credential query params and URL passwords in a URL or
 * a path with a query. With the project's `read_content` off, only keys known
 * to carry no content are kept: what ingest keeps in `otel_spans`, plus the
 * OTel resource and transport namespaces. Raw bodies come before
 * normalization, so content can sit under any vendor's key; a keep-list is
 * the only safe filter.
 */

export interface RawViewPolicy {
  /** `session_replay_settings.read_content`: show message content. */
  readContent: boolean;
}

export const REDACTED = "[REDACTED]";

/** OTel namespaces that describe the process, the host or the transport, never a message. */
const CONTENT_FREE_PREFIXES = [
  "service.",
  "telemetry.",
  "deployment.",
  "host.",
  "os.",
  "process.",
  "cloud.",
  "k8s.",
  "container.",
  "http.",
  "url.",
  "server.",
  "client.",
  "network.",
  "rpc.",
  "error.",
  "otel.",
] as const;
/** A key's last segment (lowercase, `-` as `_`) that names a credential. */
const CREDENTIAL_NAME =
  /(^|_)(api_?key|access_?key|secret_?key|private_?key|secret|password|passwd|token|credentials?|authorization|cookie)$/;
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  "process.command_line",
  "process.command_args",
]);
/** Query params that carry a credential beyond `CREDENTIAL_NAME`. */
const CREDENTIAL_PARAMS: ReadonlySet<string> = new Set([
  "key",
  "auth",
  "code",
  "sig",
  "signature",
  "x_amz_signature",
  "x_goog_signature",
]);
/** `scheme://user:password@`: the password runs to the last `@` before the host. */
const URL_PASSWORD = /(:\/\/[^/?#\s:@]*:)[^/?#\s]*@/g;
const QUERY_PARAM = /([?&;])([^=&#;?\s]+)=([^&#;\s]*)/g;
const BARE_QUERY_PARAM = /(^|[?&;])([^=&#;?\s]+)=([^&#;\s]*)/g;
/** A path with a query: `/v1/models?…`, alone or after a word (`GET /v1?…`). */
const PATH_WITH_QUERY = /(^|\s)\/[^\s?]*\?/;

export function redactAttributes(
  attributes: AttrMap,
  policy: RawViewPolicy,
  nested = false,
): AttrMap {
  const out: AttrMap = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!nested && !policy.readContent && !isContentFreeKey(key)) continue;
    out[key] = isCredentialKey(key) ? REDACTED : redactValue(key, value, policy);
  }
  return out;
}

export function redactEvent(event: DecodedEvent, policy: RawViewPolicy): DecodedEvent {
  return {
    ...event,
    name: redactText(event.name),
    attributes: redactAttributes(event.attributes, policy),
  };
}

export function redactKeyValues(
  values: RawKeyValue[] | undefined,
  policy: RawViewPolicy,
  nested = false,
): RawKeyValue[] | undefined {
  if (!values) return values;
  return values.flatMap((entry) => {
    const key = entry.key ?? "";
    if (!nested && !policy.readContent && !isContentFreeKey(key)) return [];
    const value = isCredentialKey(key)
      ? { stringValue: REDACTED }
      : redactAnyValue(key, entry.value, policy);
    return [{ ...entry, value }];
  });
}

/** Free text (a span name, a status message): URL credentials only. */
export function redactText(text: string): string {
  return redactUrlText("", text);
}

function isContentFreeKey(key: string): boolean {
  return (
    isContentFreeAttributeKey(key) ||
    key === "exception.type" ||
    CONTENT_FREE_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/** A key that names a credential: auth headers, cookies, API keys, tokens, passwords, the command line. */
export function isCredentialKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (CREDENTIAL_KEYS.has(lower)) return true;
  return CREDENTIAL_NAME.test(normalizedName(lower.slice(lower.lastIndexOf(".") + 1)));
}

function redactValue(key: string, value: AttrValue, policy: RawViewPolicy): AttrValue {
  if (typeof value === "string") return redactUrlText(key, value);
  if (Array.isArray(value)) return value.map((item) => redactValue(key, item, policy));
  if (value && typeof value === "object") return redactAttributes(value, policy, true);
  return value;
}

function redactAnyValue(
  key: string,
  value: RawAnyValue | undefined,
  policy: RawViewPolicy,
): RawAnyValue | undefined {
  if (!value) return value;
  if (typeof value.stringValue === "string")
    return { ...value, stringValue: redactUrlText(key, value.stringValue) };
  if (value.arrayValue) {
    return {
      arrayValue: {
        values: value.arrayValue.values?.map((item) => redactAnyValue(key, item, policy) ?? {}),
      },
    };
  }
  if (value.kvlistValue)
    return { kvlistValue: { values: redactKeyValues(value.kvlistValue.values, policy, true) } };
  return value;
}

/** Credential query params and URL passwords in a URL, a path with a query, or a bare query (`url.query`). */
function redactUrlText(key: string, text: string): string {
  const bareQuery = key.toLowerCase().endsWith("url.query");
  if (!bareQuery && !text.includes("://") && !PATH_WITH_QUERY.test(text)) return text;
  return text
    .replace(URL_PASSWORD, `$1${REDACTED}@`)
    .replace(
      bareQuery ? BARE_QUERY_PARAM : QUERY_PARAM,
      (match, separator: string, name: string) =>
        isCredentialParam(name) ? `${separator}${name}=${REDACTED}` : match,
    );
}

function isCredentialParam(name: string): boolean {
  const normalized = normalizedName(safeDecode(name));
  return CREDENTIAL_PARAMS.has(normalized) || CREDENTIAL_NAME.test(normalized);
}

function normalizedName(name: string): string {
  return name.toLowerCase().replace(/-/g, "_");
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
