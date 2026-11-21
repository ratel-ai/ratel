/**
 * Whether a tool `unknown_tool` names really is missing. The detector's menu
 * path fires on a name absent from a turn's captured tool list, and a captured
 * list can be incomplete, so the signal alone does not say the tool does not
 * exist. Its stored metrics may not say either: `calls === unknown` when every
 * call is a menu miss, however many of them succeeded, and rows written before
 * `okCalls` lack that field. So the standing is read from the catalog and the
 * ok calls. Pure: the loaders read, this decides.
 */

/** `missing` is the one standing that still means "a tool to build". */
export type UnknownToolStanding = "succeeded" | "in_catalog" | "missing";
export type ExistingToolStanding = Exclude<UnknownToolStanding, "missing">;

export interface UnknownToolEvidence {
  /** `catalogIdentities` of the project's catalog. */
  catalog: ReadonlySet<string>;
  /** Tools with an ok call in the window that the stored metrics may not show. */
  succeededToolIds: ReadonlySet<string>;
}

type SignalLike = { kind: string; subjectKey: string; metrics: Readonly<Record<string, unknown>> };

const NOTHING: ReadonlySet<string> = new Set();

export function unknownToolStanding(
  toolId: string,
  metrics: Readonly<Record<string, unknown>>,
  evidence: UnknownToolEvidence,
): UnknownToolStanding {
  if (storedOkCalls(metrics) || evidence.succeededToolIds.has(toolId)) return "succeeded";
  return evidence.catalog.has(toolId) ? "in_catalog" : "missing";
}

/** A catalog's ids and names: a called name is an OTel span's, and an entry's id may differ from its name. */
export function catalogIdentities(names: ReadonlyMap<string, string>): ReadonlySet<string> {
  return new Set([...names.keys(), ...names.values()]);
}

/** The `unknown_tool` tools whose ok calls have to be looked up, leaving out `skip` and those the row already shows. */
export function unknownToolsToProbe(
  signals: readonly SignalLike[],
  skip: ReadonlySet<string> = NOTHING,
): string[] {
  const ids = signals
    .filter(
      (signal) =>
        signal.kind === "unknown_tool" &&
        !storedOkCalls(signal.metrics) &&
        !skip.has(signal.subjectKey),
    )
    .map((signal) => signal.subjectKey);
  return [...new Set(ids)];
}

/** Each `unknown_tool` record that is about an existing tool, told so in `metrics.toolStanding` for its copy. Read time only: never stored. */
export function withToolStandings<T extends SignalLike>(
  records: readonly T[],
  evidence: UnknownToolEvidence,
): T[] {
  return records.map((record) => {
    if (record.kind !== "unknown_tool") return record;
    const standing = unknownToolStanding(record.subjectKey, record.metrics, evidence);
    return standing === "missing"
      ? record
      : { ...record, metrics: { ...record.metrics, toolStanding: standing } };
  });
}

/** `withToolStandings` from the stored ok calls alone, for a job that reads neither the catalog nor the ledger. */
export function withStoredToolStandings<T extends SignalLike>(records: readonly T[]): T[] {
  return withToolStandings(records, { catalog: NOTHING, succeededToolIds: NOTHING });
}

/** The standing `withToolStandings` set, or null when the record is told as a missing tool. */
export function existingToolStanding(
  metrics: Readonly<Record<string, unknown>>,
): ExistingToolStanding | null {
  return metrics.toolStanding === "succeeded" || metrics.toolStanding === "in_catalog"
    ? metrics.toolStanding
    : null;
}

function storedOkCalls(metrics: Readonly<Record<string, unknown>>): boolean {
  return typeof metrics.okCalls === "number" && metrics.okCalls > 0;
}
