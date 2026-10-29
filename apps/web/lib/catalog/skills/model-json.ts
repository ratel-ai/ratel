/**
 * Extract a JSON object from a model's free-text response.
 *
 * Shared by the places that ask a model for JSON and parse the reply as text
 * (`lib/match-quality/analyst.ts`, `lib/trace-signals/workflows/label.ts`). A bare
 * `JSON.parse(raw.slice(firstBrace, lastBrace + 1))` loses the entire reply
 * whenever the model emits a RAW control character inside a string literal
 * (overwhelmingly a literal newline inside a multi-line markdown field):
 *
 *   Bad control character in string literal in JSON at position 1684
 *
 * That is a *formatting* slip in otherwise-correct output, so the extractor
 * repairs it rather than discarding the response. Structural whitespace between
 * tokens is left untouched — only characters inside a string literal are escaped
 * — so pretty-printed JSON survives unchanged.
 *
 * Repair is the second line of defence. The first is `output_config.format`
 * (structured outputs), which constrains the model to emit schema-valid JSON in
 * the first place. This path still matters for injected/test completions and any
 * model that doesn't support the constraint.
 *
 * Genuinely broken output — no object at all, or one truncated mid-string by a
 * `max_tokens` cut — throws {@link ModelJsonError} instead of being guessed at.
 */

/** Bytes of the offending response to include in the error (bounded — it is model output, and can be long). */
const MAX_SNIPPET = 300;

/** Raised when a model response contains no recoverable JSON object. */
export class ModelJsonError extends Error {
  constructor(reason: string, raw: string) {
    super(`${reason}: ${raw.slice(0, MAX_SNIPPET)}`);
    this.name = "ModelJsonError";
  }
}

/**
 * Escape raw control characters that appear INSIDE string literals, leaving
 * everything else — including the whitespace that separates tokens — byte-identical.
 *
 * Walks the text tracking whether we are inside a string. `escaped` deliberately
 * toggles rather than being set, so a literal `\\` correctly ends the escape and a
 * newline immediately after it is still recognised as raw.
 */
function escapeControlCharsInStrings(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (const char of json) {
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && inString) {
      out += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      out += char;
      continue;
    }
    // Only characters inside a string need escaping; outside one, a control
    // character is ordinary JSON whitespace and must be preserved as-is.
    if (inString && char < " ") {
      out +=
        { "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" }[char] ??
        `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * The first JSON object in `raw`, tolerating code fences and surrounding prose.
 * Repairs raw control characters inside string literals; throws
 * {@link ModelJsonError} when the response holds no parseable object.
 */
export function extractModelJsonObject(raw: string): unknown {
  const unfenced = raw.replace(/```(?:json)?/gi, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new ModelJsonError("model response contained no JSON object", raw);
  }

  const candidate = unfenced.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    // Most likely a raw control character inside a string — repair and retry once.
    try {
      return JSON.parse(escapeControlCharsInStrings(candidate));
    } catch (err) {
      // Not repairable: truncated mid-object (a max_tokens cut) or malformed in a
      // way we shouldn't guess at. Fail loudly rather than persist a partial skill.
      throw new ModelJsonError(
        `model response was not valid JSON (${err instanceof Error ? err.message : String(err)})`,
        raw,
      );
    }
  }
}
