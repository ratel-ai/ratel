import { redirect } from "next/navigation";
import { composition } from "@/lib/composition/ports";
import { organizationOnHold, projectOnHold } from "./state";

/** Where a reader lands who opens a workspace on hold. */
export const MAINTENANCE_PATH = "/maintenance";

export interface ConsoleHoldDeps {
  projectOnHold: typeof projectOnHold;
  organizationOnHold: typeof organizationOnHold;
  /** An operator's support session, confirmed by the edition. */
  inSupportSession: () => Promise<boolean>;
}

const defaultDeps: ConsoleHoldDeps = {
  projectOnHold,
  organizationOnHold,
  inSupportSession: async () => (await composition.session.actingAs()) !== null,
};

/**
 * Whether the console is closed for this reader. An operator in a support session may look: that
 * is how a workspace is checked before it opens.
 */
export async function consoleClosed(
  target: { project: { id: string; organizationId: string } } | { organizationId: string },
  deps: ConsoleHoldDeps = defaultDeps,
): Promise<boolean> {
  const held =
    "project" in target
      ? await deps.projectOnHold(target.project)
      : await deps.organizationOnHold(target.organizationId);
  return held && !(await deps.inSupportSession());
}

/** The same, sending the reader to the maintenance page. */
export async function requireConsoleOpen(
  target: Parameters<typeof consoleClosed>[0],
): Promise<void> {
  if (await consoleClosed(target)) redirect(MAINTENANCE_PATH);
}
