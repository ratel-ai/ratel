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
