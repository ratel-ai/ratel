/** Words about JSON from outside, which may hold anything. */

const SHOWN_CHARS = 80;

export const NUL_PROBLEM = "A name or a value has a NUL character. Remove it.";

/** PostgreSQL has no text with a NUL: one that passes here fails where it is stored or compared. */
export function hasNoNul(value: string): boolean {
  return !value.includes("\0");
}

/** A wrong value as an error names it. Never `String(value)`: an object's `toString` may be no function. */
export function shownValue(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value.length > SHOWN_CHARS ? `${value.slice(0, SHOWN_CHARS)}…` : value;
    case "object":
      return value === null ? "null" : Array.isArray(value) ? "a list" : "an object";
    case "number":
    case "boolean":
    case "undefined":
      return `${value}`;
    default:
      return typeof value;
  }
}
