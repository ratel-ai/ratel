import type { Workspace, WorkspacePort } from "@/lib/contracts/workspace";

const workspaces: Workspace[] = [
  { id: "ws-1", name: "Production" },
  { id: "ws-2", name: "Staging" },
  { id: "ws-3", name: "Sandbox" },
];

export const cloudWorkspace: WorkspacePort = {
  async listWorkspaces() {
    return workspaces;
  },
  async currentWorkspace() {
    return workspaces[0];
  },
};
