export type Workspace = {
  name: string;
};

export type Runtime = {
  edition: string;
  workspace: Workspace;
  workspaces: Workspace[];
};

/**
 * UI contract: edition label + current workspace + available workspaces.
 * S3 replaces this body with the composition lookup; keep the signature stable.
 */
export function getRuntime(): Runtime {
  const workspace: Workspace = { name: "Local workspace" };
  return {
    edition: "Ratel OSS",
    workspace,
    workspaces: [workspace],
  };
}
