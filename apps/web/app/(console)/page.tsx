import { WorkspaceCard } from "@/components/workspace-card";
import { getRuntime } from "@/lib/runtime";

export default function HomePage() {
  const runtime = getRuntime();

  return (
    <>
      <p
        style={{
          margin: 0,
          fontSize: 14,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--ratel-indigo)",
        }}
      >
        Edition
      </p>
      <h1 style={{ margin: "8px 0 0", fontSize: 40, fontWeight: 700 }}>{runtime.edition}</h1>
      <WorkspaceCard workspace={runtime.workspace} workspaces={runtime.workspaces} />
    </>
  );
}
