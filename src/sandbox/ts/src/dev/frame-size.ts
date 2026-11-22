// Keeps every frame within the protocol limit (65536 UTF-8 bytes). Long text is
// split (text.delta) or cut with a marker. A large JSON value is replaced by a
// preview object with the same marker, so the controller can tell it apart.

export const TRUNCATION_MARKER = "…[truncated by ratel sandbox dev]";

/** Bytes of a value as it goes on the wire inside a frame. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null");
}

/**
 * Splits text into chunks whose JSON form is at most maxBytes. Splits on code
 * points, never inside a surrogate pair.
 */
export function splitText(text: string, maxBytes: number): string[] {
  if (jsonBytes(text) <= maxBytes) return [text];
  const chunks: string[] = [];
  let chunk = "";
  let size = 2; // the quotes
  for (const char of text) {
    const charBytes = jsonBytes(char) - 2;
    if (size + charBytes > maxBytes && chunk !== "") {
      chunks.push(chunk);
      chunk = "";
      size = 2;
    }
    chunk += char;
    size += charBytes;
  }
  if (chunk !== "") chunks.push(chunk);
  return chunks;
}

/** Cuts text so its JSON form plus the marker fits in maxBytes. */
export function truncateText(text: string, maxBytes: number): string {
  if (jsonBytes(text) <= maxBytes) return text;
  const room = Math.max(0, maxBytes - jsonBytes(TRUNCATION_MARKER) + 2);
  const [head = ""] = splitText(text, room);
  return `${head}${TRUNCATION_MARKER}`;
}

/** A value whose JSON is over maxBytes becomes `{ truncated, bytes, preview }`, within maxBytes. */
export function truncateValue(value: unknown, maxBytes: number): unknown {
  const bytes = jsonBytes(value);
  if (bytes <= maxBytes) return value;
  const shell = { truncated: true, bytes, preview: "" };
  const room = maxBytes - jsonBytes(shell);
  return { ...shell, preview: truncateText(JSON.stringify(value), room) };
}
