import type { UsageCheck, UsageRefusal } from "@/lib/contracts/usage-limits";
import type { CreateVersionInput } from "../domain/config";
import type { SandboxVersion } from "../domain/version";

export type NewVersion = CreateVersionInput & { projectId: string; apiKeyId: string | null };

/** The versions of a project. Every read and write names the project. */
export interface VersionStore {
  /**
   * Adds a version when `check` passes. `check` gets the number of versions of this UTC day. Two
   * pushes of a project at the same time do not see the same number.
   */
  create(
    input: NewVersion,
    check: (today: number) => Promise<UsageCheck>,
  ): Promise<{ ok: true; version: SandboxVersion } | UsageRefusal>;
  get(projectId: string, versionId: string): Promise<SandboxVersion | null>;
  /** The newest first. */
  list(projectId: string, limit: number): Promise<SandboxVersion[]>;
  /** `uploading` to `uploaded`. False when the version has another status. */
  markUploaded(projectId: string, versionId: string): Promise<boolean>;
}
