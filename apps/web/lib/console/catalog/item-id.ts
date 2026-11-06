/**
 * The selected catalog item lives in the URL (`?item=tool:<name>` or
 * `?item=skill:<id>`), so refresh, Back and a shared link land on the same
 * item (DESIGN.md, Everything is a URL). Pure, so it tests without a router.
 */

export type CatalogItemKind = "tool" | "skill";

export const ITEM_PARAM = "item";

/** Ids past this are not ours: a tool name or a skill id is far shorter. */
const MAX_ITEM_ID_LENGTH = 512;

export interface CatalogItemRef {
  kind: CatalogItemKind;
  id: string;
}

/** `tool:<name>` or `skill:<id>`. A tool is keyed by its name, a skill by its id. */
export function itemKey(kind: CatalogItemKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Read an item id from the URL. Anything malformed (unknown kind, empty or
 * oversized id, control characters) reads as no selection rather than as an
 * item that will never be found.
 */
export function parseItemKey(value: string | null | undefined): CatalogItemRef | null {
  if (typeof value !== "string") return null;
  const separator = value.indexOf(":");
  if (separator < 0) return null;
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (kind !== "tool" && kind !== "skill") return null;
  if (id.trim() === "" || id.length > MAX_ITEM_ID_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(id)) return null;
  return { kind, id };
}

/**
 * The query string (with its `?`, or empty) after selecting `key`, or clearing
 * the selection when `key` is null. Other parameters are kept. The colon stays
 * readable (`?item=tool:ripgrep`): it is legal in a query and it is what people
 * type and share.
 */
export function withQueryParam(search: string, param: string, value: string | null): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (value === null || value === "") params.delete(param);
  else params.set(param, value);
  const query = params.toString().replace(/%3A/gi, ":");
  return query ? `?${query}` : "";
}

export function withItemParam(search: string, key: string | null): string {
  return withQueryParam(search, ITEM_PARAM, key);
}

/** Several parameters set or cleared at once, in order. */
export function withQueryParams(
  search: string,
  patch: Readonly<Record<string, string | null>>,
): string {
  return Object.entries(patch).reduce(
    (current, [param, value]) => withQueryParam(current, param, value),
    search,
  );
}
