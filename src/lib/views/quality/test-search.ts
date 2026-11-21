/**
 * How one recorded search reopens in the Playground. An experiment's search
 * goes by its ids, which the Playground reads the ask and both rankings back
 * from; a plain recorded search has no such id, so it carries its words, and
 * the link puts them in the address only when clicked (`TestSearch`).
 */
export type SearchTest =
  | { kind: "selection"; selectionId: string; experimentName: string }
  | { kind: "query"; query: string };

export function searchTest(input: {
  query: string | null;
  selectionId: string | null;
  /** The experiment it came from; null for plain search telemetry. */
  experimentName: string | null;
}): SearchTest | null {
  if (input.selectionId && input.experimentName) {
    return {
      kind: "selection",
      selectionId: input.selectionId,
      experimentName: input.experimentName,
    };
  }
  return input.query ? { kind: "query", query: input.query } : null;
}
