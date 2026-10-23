import type { NavItem } from "@/lib/composition";
import { composition } from "@/lib/composition";
import type { Principal } from "@/lib/contracts/identity";
import type { Workspace } from "@/lib/contracts/workspace";

export type Runtime = {
  edition: string;
  principal: Principal | null;
  workspace: Workspace;
  workspaces: Workspace[];
  nav: NavItem[];
};

/**
 * Single seam the UI reads. This is the only module that adapts ports to UI shape.
 */
export async function getRuntime(): Promise<Runtime> {
  const [principal, workspace, workspaces] = await Promise.all([
    composition.identity.resolvePrincipal(),
    composition.workspace.currentWorkspace(),
    composition.workspace.listWorkspaces(),
  ]);

  return {
    edition: composition.edition,
    principal,
    workspace,
    workspaces,
    nav: composition.nav,
  };
}
