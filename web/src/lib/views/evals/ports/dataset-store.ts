import type { Dataset, DatasetDefinition } from "../domain/dataset";

export type NewDataset = {
  projectId: string;
  name: string;
  definition: DatasetDefinition;
  createdBy: string;
};

/** The datasets of a project (decision `datasets-first-class`). The rows of a fixed one are cases. */
export interface DatasetStore {
  create(input: NewDataset): Promise<Dataset | "name_taken">;
  get(projectId: string, datasetId: string): Promise<Dataset | null>;
  getByName(projectId: string, name: string): Promise<Dataset | null>;
  /** The oldest first. */
  list(projectId: string): Promise<Dataset[]>;
  /** The rows of each fixed dataset of the project and the time of its newest row, by its id. */
  rowStats(projectId: string): Promise<Map<string, { rows: number; lastAddedAt: Date | null }>>;
}
