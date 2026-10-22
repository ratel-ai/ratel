export type Workspace = {
  id: string;
  name: string;
};

export type WorkspacePort = {
  listWorkspaces(): Promise<Workspace[]>;
  currentWorkspace(): Promise<Workspace>;
};
