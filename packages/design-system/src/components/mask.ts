/** Mask all but the prefix and the last four characters of a secret. */
export function maskSecret(value: string): string {
  if (value.length <= 12) return "•".repeat(value.length);
  const underscore = value.indexOf("_");
  const prefixEnd = underscore >= 0 && underscore < 8 ? underscore + 1 : 4;
  return `${value.slice(0, prefixEnd)}${"•".repeat(12)}${value.slice(-4)}`;
}
