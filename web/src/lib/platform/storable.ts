/** The value without the characters that Postgres does not store: NUL and a half of a pair. */
export function storable<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (typeof item === "string") return storableText(item);
      if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
      return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => [storableText(key), entry]),
      );
    }),
  );
}

function storableText(text: string): string {
  return text.replaceAll("\0", "").toWellFormed();
}
