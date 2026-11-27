import type { SandboxVersion } from "../domain/version";

/** One sandbox of a project, as the list shows it. */
export type SandboxSummary = {
  name: string;
  /** The newest version, of any status. */
  newest: SandboxVersion;
  versions: number;
  /** The newest run of any version of the sandbox, eval trials too. Null: no run yet. */
  lastRunAt: Date | null;
};

/** The sandboxes of a project. */
export interface SandboxIndex {
  /** The sandbox with the newest push first. */
  list(projectId: string): Promise<SandboxSummary[]>;
}
