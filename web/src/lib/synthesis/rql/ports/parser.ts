import type { ParseResult } from "../domain/ast";

/**
 * Reads query text into the parsed tree of `domain/ast.ts`. It refuses nothing that it can parse:
 * a construct that RQL refuses becomes a `foreign` node, and the checker gives the error. It never
 * throws; text it cannot parse is `{ ok: false }` with the parser's message.
 */
export interface RqlParser {
  parse(text: string): ParseResult;
}
