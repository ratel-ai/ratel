/**
 * Where a fix is handed off to (RC-918): a port, so a GitHub issue for Claude
 * Code is the first target and others (a pull request, another agent) can
 * follow without touching the use case.
 */

/** What is handed off: the fix, its title and the brief a coding agent acts on. */
export interface HandoffRequest {
  fixId: string;
  title: string;
  brief: string;
}

/** The linked repo, as the installation of the App reaches it. */
export interface HandoffRepo {
  installationId: number;
  owner: string;
  name: string;
}

export interface HandoffTarget {
  /** Stored on `fix_handoffs.target`; one handoff per fix and target. */
  id: string;
  handoff(request: HandoffRequest, repo: HandoffRepo): Promise<{ externalId: string; url: string }>;
}
