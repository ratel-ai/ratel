import type { CaseContent, EvalCase } from "../domain/case";
import type {
  Dataset,
  DatasetDetails,
  DatasetQuery,
  ResolvedRow,
  ValueRow,
} from "../domain/dataset";

export type NewDataset = DatasetDetails & {
  projectId: string;
  query: DatasetQuery;
  createdBy: string;
};

/**
 * A row of a fixed dataset: a trace turn (or a sandbox run, with no turn) with its frozen copy, or
 * typed values.
 */
export type NewRow = { name: string; labels?: string[] } & (
  | { kind: "trace"; turnId: string | null; content: CaseContent; sourceOutput: string | null }
  | { kind: "values"; row: ValueRow }
);

export type DatasetSummary = Dataset & {
  /** The rows of a fixed dataset. A query kind has no row until a run resolves it. */
  rowCount: number;
};

/**
 * The datasets of a project and their rows. A row is a case (`CaseStore`): a version never
 * changes, and the newest counts (decision `rows-count-at-once`).
 */
export interface DatasetStore {
  create(input: NewDataset): Promise<Dataset | "name_taken">;
  get(projectId: string, datasetId: string): Promise<Dataset | null>;
  getByName(projectId: string, name: string): Promise<Dataset | null>;
  /** The newest first. */
  list(projectId: string): Promise<DatasetSummary[]>;
  /** Adds the rows in one transaction, in order. `not_fixed`: a query kind holds no row. */
  addRows(
    projectId: string,
    datasetId: string,
    rows: readonly NewRow[],
    createdBy: string,
  ): Promise<EvalCase[] | "not_found" | "not_fixed">;
  /**
   * Adds rows that one run uses for itself only: they are not rows of the dataset. A dataset of any
   * kind takes them.
   */
  addRunRows(
    projectId: string,
    datasetId: string,
    rows: readonly NewRow[],
    createdBy: string,
  ): Promise<EvalCase[] | "not_found">;
  /**
   * Removes a row from a fixed dataset. Its versions stay, so the runs that froze them still read
   * them. `not_found`: no such row in the dataset of the project, or removed already.
   */
  removeRow(
    projectId: string,
    datasetId: string,
    rowId: string,
    now: Date,
  ): Promise<"removed" | "not_found" | "not_fixed">;
  /** The rows of a fixed dataset, the newest first. No row that a query resolved or a run added. */
  rows(projectId: string, datasetId: string): Promise<EvalCase[]>;
  /**
   * Keeps the rows that a query resolved, one row for each turn: a turn seen before gets a new
   * version when its content changed. In the order of `rows`, each with its newest version first.
   */
  keepResolved(
    projectId: string,
    datasetId: string,
    rows: readonly ResolvedRow[],
    createdBy: string,
  ): Promise<EvalCase[]>;
}
