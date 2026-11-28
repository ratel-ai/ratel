import { fail } from "./errors";
import { RQL_LIMITS } from "./limits";

/**
 * The checks before the parse. The parser takes time that grows faster than the text, so the
 * compiler refuses, in one linear pass, a text that is too long, a second statement after a `;`,
 * a list of more than `maxListItems` items and parentheses deeper than `maxExpressionDepth`.
 * The pass skips quoted text, quoted names and comments.
 */

/** The words that start a clause: a comma list at the top level starts again after each one. */
const CLAUSE_WORDS = new Set(["select", "from", "where", "group", "having", "order", "limit"]);

/** Stops the compile with an error when the text is out of bounds. */
export function guardText(text: string): void {
  if (text.length > RQL_LIMITS.maxTextChars) {
    fail(
      "query_too_long",
      `The query has ${text.length} characters. RQL reads at most ${RQL_LIMITS.maxTextChars}.`,
      "Write a shorter query: select fewer columns, or split the question into two queries.",
    );
  }
  // The count of list items at each depth of parentheses; index 0 is the top level.
  const items: number[] = [1];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "'") {
      i = skipQuoted(text, i, "'", isEscapeString(text, i));
      continue;
    }
    if (ch === '"') {
      i = skipQuoted(text, i, '"', false);
      continue;
    }
    if (ch === "-" && next === "-") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 64))?.[0];
      if (tag) {
        const end = text.indexOf(tag, i + tag.length);
        i = end < 0 ? text.length : end + tag.length;
        continue;
      }
    }
    if (ch === ";") {
      if (!onlySpaceAfter(text, i + 1)) {
        fail(
          "multiple_statements",
          "The query has more than one statement.",
          "Send one SELECT statement. Run a second query for a second question.",
        );
      }
      return;
    }
    if (ch === "(") {
      items.push(1);
      if (items.length - 1 > RQL_LIMITS.maxExpressionDepth) {
        fail(
          "syntax_error",
          `The query nests more than ${RQL_LIMITS.maxExpressionDepth} levels of parentheses.`,
          "Write a flatter expression.",
        );
      }
    } else if (ch === ")") {
      if (items.length > 1) items.pop();
    } else if (ch === ",") {
      const depth = items.length - 1;
      items[depth] += 1;
      if (items[depth] > RQL_LIMITS.maxListItems) {
        fail(
          "too_many_items",
          `The query has a list of more than ${RQL_LIMITS.maxListItems} items.`,
          `Give at most ${RQL_LIMITS.maxListItems} items in one list (IN, GROUP BY, ORDER BY or the select).`,
        );
      }
    } else if (items.length === 1 && isWordStart(text, i)) {
      const word = /^[A-Za-z_]+/.exec(text.slice(i, i + 16))?.[0] ?? "";
      if (CLAUSE_WORDS.has(word.toLowerCase())) items[0] = 1;
      i += Math.max(word.length, 1);
      continue;
    }
    i += 1;
  }
}

/** The index after the closing quote. A doubled quote is one quote; in E'...' a backslash escapes. */
function skipQuoted(text: string, start: number, quote: string, backslash: boolean): number {
  let i = start + 1;
  while (i < text.length) {
    if (backslash && text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === quote) {
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return text.length;
}

function isEscapeString(text: string, quoteAt: number): boolean {
  const before = text[quoteAt - 1];
  return (before === "E" || before === "e") && !/[A-Za-z0-9_]/.test(text[quoteAt - 2] ?? "");
}

function isWordStart(text: string, i: number): boolean {
  return /[A-Za-z_]/.test(text[i]) && !/[A-Za-z0-9_$]/.test(text[i - 1] ?? "");
}

/** Whether only spaces and comments follow `from`. */
function onlySpaceAfter(text: string, from: number): boolean {
  const rest = text
    .slice(from)
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return rest.trim() === "";
}
