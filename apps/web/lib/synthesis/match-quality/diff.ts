/**
 * A word-level diff between the current searchable description and a proposed one.
 *
 * The surface previously printed the two strings side by side and asked a reader to
 * spot the difference themselves. In this feature the difference is usually a short
 * appended clause inside two otherwise identical sentences, which is exactly the case
 * human eyes are worst at: the blocks look the same, so nothing draws attention and
 * there is no obvious place to start reading.
 *
 * Diffing on WORDS rather than characters is deliberate. A character diff of two
 * sentences that share most of their letters produces confetti, highlighting fragments
 * inside words and reading as noise. Words are also the unit BM25 actually indexes, so
 * a highlighted run here corresponds to something that genuinely changes retrieval.
 */

export type DiffOp = "same" | "added" | "removed";

export interface DiffSpan {
  op: DiffOp;
  /** Joined text including its trailing whitespace, so spans concatenate back. */
  text: string;
}

/**
 * Bound on the token count either side. Descriptions are capped at 4KB, so this is
 * far above any real input; it exists so a pathological string cannot make the O(n·m)
 * table quadratic in something unbounded. Past it, the diff degrades to a plain
 * replacement, which is still correct, just less granular.
 */
const MAX_TOKENS = 400;

/** Split into words, keeping each word's trailing whitespace attached. */
export function tokenize(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

/**
 * The longest common subsequence table, as lengths.
 *
 * Plain dynamic programming rather than a library: the inputs are two short strings,
 * and a dependency for this would be more code than the eighteen lines it replaces.
 */
function lcsLengths(left: readonly string[], right: readonly string[]): number[][] {
  const table: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i][j] =
        left[i].trim() === right[j].trim()
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

/** Append to the last span when the op matches, so runs stay whole. */
function push(spans: DiffSpan[], op: DiffOp, text: string): void {
  const last = spans[spans.length - 1];
  if (last && last.op === op) last.text += text;
  else spans.push({ op, text });
}

/**
 * Diff two descriptions into spans a renderer can colour directly.
 *
 * Returns `same` spans for shared words, `removed` for words only in `before`, and
 * `added` for words only in `after`. Rendering `same` + `added` reproduces `after`
 * exactly; `same` + `removed` reproduces `before`.
 */
export function diffWords(before: string, after: string): DiffSpan[] {
  const left = tokenize(before);
  const right = tokenize(after);

  if (left.length === 0 && right.length === 0) return [];
  if (left.length > MAX_TOKENS || right.length > MAX_TOKENS) {
    const spans: DiffSpan[] = [];
    if (before) spans.push({ op: "removed", text: before });
    if (after) spans.push({ op: "added", text: after });
    return spans;
  }

  const table = lcsLengths(left, right);
  const spans: DiffSpan[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i].trim() === right[j].trim()) {
      // The AFTER token carries the spacing a reader sees in the proposed text.
      push(spans, "same", right[j]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push(spans, "removed", left[i++]);
    } else {
      push(spans, "added", right[j++]);
    }
  }
  while (i < left.length) push(spans, "removed", left[i++]);
  while (j < right.length) push(spans, "added", right[j++]);
  return spans;
}

/** How much of the proposal is genuinely new, in [0, 1]. */
export function changeShare(spans: readonly DiffSpan[]): number {
  let changed = 0;
  let total = 0;
  for (const span of spans) {
    const length = span.text.trim().length;
    total += length;
    if (span.op !== "same") changed += length;
  }
  return total === 0 ? 0 : changed / total;
}

/**
 * Whether the change is purely additive.
 *
 * Worth saying on the surface: an append is a safe change a reader can skim, while a
 * rewrite that removes words is one they should read properly before applying.
 */
export function isPureAddition(spans: readonly DiffSpan[]): boolean {
  return spans.length > 0 && !spans.some((span) => span.op === "removed");
}
