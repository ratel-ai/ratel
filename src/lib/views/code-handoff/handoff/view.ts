import type { FixHandoffRow, RepoLinkRow } from "@/lib/views/code-handoff/schema";
import { repositorySettingsPath } from "../paths";
import { GITHUB_ISSUE_CLAUDE_TARGET } from "./github-issue-claude";
import type { HandoffError } from "./handoff-fix";

/**
 * What the Hand off button on a fix shows (RC-918): nothing with the flag
 * off; a link to Settings › Repository without a linked repo; the issue once
 * the fix was handed off; else the button. Pure apart from its reads.
 */

export interface HandoffButtonState {
  linked: boolean;
  settingsHref: string;
  /** The issue the fix was handed off to, when it was. */
  issueUrl: string | null;
}

export interface HandoffButtonDeps {
  flagEnabled: () => Promise<boolean>;
  getRepoLink: (projectId: string) => Promise<RepoLinkRow | null>;
  getHandoff: (projectId: string, fixId: string, target: string) => Promise<FixHandoffRow | null>;
}

/** Why a public repo (or one Ratel cannot read) is refused: the issue body holds trace data. */
export const PUBLIC_REPO_MESSAGE =
  "This repo is public. Ratel hands off fixes only to private repos, because the brief holds trace data.";

/** What a person reads when a handoff is refused or fails. */
export const HANDOFF_ERROR_MESSAGES: Record<HandoffError | "forbidden" | "failed", string> = {
  flag_off: "Handing off fixes is not available for this project.",
  no_repo_linked: "Link a GitHub repository in Settings › Repository first.",
  public_repo: PUBLIC_REPO_MESSAGE,
  fix_not_found: "This fix no longer exists.",
  forbidden: "You can't hand off fixes of this project.",
  failed: "GitHub did not open the issue. Try again in a minute.",
};

/** The button's state, or null when the flag is off (no button). */
export async function loadHandoffButtonState(
  projectId: string,
  fixId: string,
  deps: HandoffButtonDeps,
): Promise<HandoffButtonState | null> {
  if (!(await deps.flagEnabled())) return null;
  const settingsHref = repositorySettingsPath(projectId);
  const link = await deps.getRepoLink(projectId);
  if (!link) return { linked: false, settingsHref, issueUrl: null };
  const handoff = await deps.getHandoff(projectId, fixId, GITHUB_ISSUE_CLAUDE_TARGET);
  return { linked: true, settingsHref, issueUrl: handoff?.url ?? null };
}
