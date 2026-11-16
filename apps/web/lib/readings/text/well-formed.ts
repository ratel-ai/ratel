/**
 * `text.slice(0, max)` for text that goes out as JSON. `slice` counts UTF-16
 * units, so a cut can land inside an emoji. `JSON.stringify` then writes a lone
 * `\ud83d`, and model providers reject the whole request body for it.
 *
 * The result is never longer than `max` and is always well-formed: a cut inside
 * a pair drops the pair, and a surrogate already alone in the text becomes
 * U+FFFD, as it does when Postgres stores it.
 */
export function sliceWellFormed(text: string, max: number): string {
  const whole = text.toWellFormed();
  if (whole.length <= max) return whole;
  const last = whole.charCodeAt(max - 1);
  return whole.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * `value` with each string and object key made well-formed, for a request body
 * to a model provider. `JSON.stringify` writes a lone surrogate as `\ud83d`, so
 * the JSON text cannot be repaired after that. Every model provider client sends
 * through this, so a future cut cannot reject a whole request. Text that is
 * already well-formed does not change. An object that is not plain, such as a
 * Date, stays as it is.
 */
export function wellFormedJson<T>(value: T): T {
  if (typeof value === "string") return value.toWellFormed() as T;
  if (Array.isArray(value)) return value.map(wellFormedJson) as T;
  if (value === null || typeof value !== "object") return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key.toWellFormed(), wellFormedJson(item)]),
  ) as T;
}
