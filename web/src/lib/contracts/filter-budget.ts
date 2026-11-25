/**
 * How long a filter may be. The Traces page is drawn from its address, so a filter that a query
 * holds must fit a request.
 *
 * The smallest limit on the way is the Node server's: 16,384 bytes for the request line and all
 * headers (`http.maxHeaderSize`, which the image does not change). Caddy takes 1 MiB
 * (`max_header_bytes`), and the AWS load balancer of Ratel Cloud 16 KB for the request line and
 * 64 KB for all headers. Measured with a 5,097-character address on Next 16.4: the address is in a
 * request once, as the router state leaves the search out. The `Referer` is the address of the page
 * before, and browsers cut one over 4,096 characters to its origin.
 */
const REQUEST_BYTES = 16_384;
const REFERER_BYTES = 4_096;
/** One cookie of the most a browser keeps: a sealed session. */
const COOKIE_BYTES = 4_096;
/** The other headers: 1,350 measured, and what a proxy adds. */
const OTHER_BYTES = 2_048;
/** The longest address of the Traces page that is sure to arrive. */
export const MAX_TRACES_URL_CHARS = REQUEST_BYTES - REFERER_BYTES - COOKIE_BYTES - OTHER_BYTES;
/** The path, two instants, the sort, the cursor, the open row. */
const REST_OF_URL_CHARS = 640;
export const MAX_PACKED_FILTER_CHARS = MAX_TRACES_URL_CHARS - REST_OF_URL_CHARS;
/** The mark of a packed value, and what deflate adds to bytes it cannot shorten. */
const PACKING_BYTES = 16;
/** A group or a step of a chart adds its names: two of 500 characters. */
const GROUP_BYTES = 1_024;

/** The bytes of a query's trace filter as JSON, all clauses together with the page's: whole KB. */
export const MAX_FILTER_BYTES =
  Math.floor(((MAX_PACKED_FILTER_CHARS * 3) / 4 - PACKING_BYTES - GROUP_BYTES) / 1_024) * 1_024;

/** Why a filter is too long, or null. The scorer of a query is no part of its trace filter. */
export function filterProblem(filter: object): string | null {
  const { scorer: _, ...clauses } = filter as { scorer?: unknown };
  const bytes = new TextEncoder().encode(JSON.stringify(clauses)).length;
  return bytes > MAX_FILTER_BYTES
    ? `The filters are too long: ${count(bytes)} bytes of JSON, ${count(MAX_FILTER_BYTES)} at most.`
    : null;
}

function count(bytes: number): string {
  return bytes.toLocaleString("en-US");
}
