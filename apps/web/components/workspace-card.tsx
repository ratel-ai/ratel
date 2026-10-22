import { Button } from "@ratel/brand/button";
import type { Workspace } from "@/lib/runtime";

export type WorkspaceCardProps = {
  workspace: Workspace;
  workspaces: Workspace[];
};

export function WorkspaceCard({ workspace, workspaces }: WorkspaceCardProps) {
  return (
    <section
      style={{
        marginTop: 32,
        padding: 24,
        border: "1px solid var(--ratel-indigo)",
        borderRadius: "var(--ratel-radius)",
        maxWidth: 480,
      }}
    >
      <h2 style={{ margin: "0 0 8px", fontSize: 18, fontWeight: 600 }}>Workspace</h2>
      <p style={{ margin: "0 0 4px" }}>
        Current: <strong>{workspace.name}</strong>
      </p>
      <p style={{ margin: "0 0 20px", opacity: 0.8 }}>
        {workspaces.length} workspace{workspaces.length === 1 ? "" : "s"} available
      </p>
      <div style={{ display: "flex", gap: 12 }}>
        <Button>Switch workspace</Button>
        <Button variant="secondary">Manage</Button>
      </div>
    </section>
  );
}
