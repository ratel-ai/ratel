import type { Workspace, WorkspacePort } from "@/lib/contracts/workspace";

const local: Workspace = { id: "local", name: "Local workspace" };

export const ossWorkspace: WorkspacePort = {
  async listWorkspaces() {
    return [local];
  },
  async currentWorkspace() {
    return local;
  },
};
