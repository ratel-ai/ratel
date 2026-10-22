import { WorkspaceCard } from "@/components/workspace-card";
import { getRuntime } from "@/lib/runtime";

// The composition is selected at boot, so the console must not be prerendered:
// a static page would bake one edition into the build and ignore the runtime value.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const runtime = await getRuntime();

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
      {runtime.principal ? (
        <p style={{ margin: "12px 0 0", fontSize: 16 }}>{runtime.principal.label}</p>
      ) : null}
      <WorkspaceCard workspace={runtime.workspace} workspaces={runtime.workspaces} />
    </>
  );
}
