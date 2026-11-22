import { createHash } from "node:crypto";

/**
 * The config hash of a set of resolved param values: lowercase hex SHA-256 of
 * their canonical JSON. Tool modes are not param values, so they are not in it.
 */
export function configHash(values: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(canonicalJson(values)).digest("hex");
}

/**
 * JSON with object keys sorted (UTF-16 code unit order) at every depth, arrays
 * in their own order and no whitespace. Two equal values give the same bytes,
 * whatever the key order they were built in.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError(`${value} is not a finite number and cannot be hashed`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new TypeError(`a ${typeof value} cannot be hashed`);
}
