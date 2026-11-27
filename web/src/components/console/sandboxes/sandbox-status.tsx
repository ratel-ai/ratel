import type { Tone } from "@ratel/design-system/badge";
import { Callout } from "@ratel/design-system/states";
import type { SandboxListModel, VersionRow } from "@/lib/views/sandboxes/page-model";

export const VERSION_STATUS: Record<VersionRow["status"], { label: string; tone: Tone }> = {
  uploading: { label: "Uploading", tone: "neutral" },
  uploaded: { label: "Waiting", tone: "neutral" },
  preparing: { label: "Preparing", tone: "info" },
  ready: { label: "Ready", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  retired: { label: "Retired", tone: "neutral" },
};

/** Each setting of the server that is missing or wrong, by its name. Nothing when all is set. */
export function ProblemsCallout({
  model,
}: {
  model: Pick<SandboxListModel, "problems" | "configured">;
}) {
  if (model.problems.length === 0) return null;
  return (
    <Callout
      tone="warning"
      title={
        model.configured ? "A setting of this server is missing" : "Sandboxes are not configured"
      }
    >
      <ul className="flex flex-col gap-1">
        {model.problems.map((problem) => (
          <li key={problem.setting}>
            <code className="font-mono text-xs font-medium">{problem.setting}</code>
            {": "}
            {problem.message}
          </li>
        ))}
      </ul>
    </Callout>
  );
}
