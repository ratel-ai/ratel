"use client";

import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Select } from "@ratel/design-system/select";
import { TabNav } from "@ratel/design-system/tabs";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { SandboxDetailModel } from "@/lib/views/sandboxes/page-model";
import { type SandboxSection, sandboxesHref, sandboxHref } from "@/lib/views/sandboxes/paths";
import { SandboxRunOnce } from "./SandboxRunOnce";
import { SandboxSecrets } from "./SandboxSecrets";
import { SandboxVersions, VersionConfiguration } from "./SandboxVersions";
import { ProblemsCallout, VERSION_STATUS } from "./sandbox-status";

const REFRESH_MS = 3_000;
const SECTIONS: ReadonlyArray<{ section: SandboxSection; label: string }> = [
  { section: "playground", label: "Playground" },
  { section: "versions", label: "Versions" },
  { section: "secrets", label: "Secrets" },
  { section: "configuration", label: "Configuration" },
];

/** One sandbox: its name, its sections as tabs, and the section of this address. */
export function SandboxView({
  model,
  section,
  configurationVersionId = null,
  canSaveCases = false,
  now,
}: {
  model: SandboxDetailModel;
  section: SandboxSection;
  /** The version that Configuration shows. Null: the newest. */
  configurationVersionId?: string | null;
  /** Whether a run can be saved as an eval case: evals on and a write allowed. */
  canSaveCases?: boolean;
  /** ISO time the page was rendered, so relative times agree on server and client. */
  now: string;
}) {
  const router = useRouter();
  const building = model.versions.some(
    (version) =>
      version.status === "preparing" || (version.status === "uploaded" && version.reason === null),
  );
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [building, router]);

  return (
    <Page>
      <PageHeader
        title={model.name}
        crumbs={[{ label: "Sandboxes", href: sandboxesHref(model.projectId) }]}
        tabs={
          <TabNav
            label="Sandbox sections"
            tabs={SECTIONS.map(({ section: tab, label }) => ({
              href: sandboxHref(model.projectId, model.name, tab),
              label,
              exact: tab === "playground",
            }))}
          />
        }
      />
      <PageBody>
        <ProblemsCallout model={model} />
        {section === "playground" ? (
          <SandboxRunOnce
            projectId={model.projectId}
            versions={model.versions}
            runs={model.runs}
            canSaveCases={canSaveCases}
            configured={model.configured}
            now={now}
          />
        ) : null}
        {section === "versions" ? (
          <SandboxVersions projectId={model.projectId} versions={model.versions} now={now} />
        ) : null}
        {section === "secrets" ? <SandboxSecrets model={model} now={now} /> : null}
        {section === "configuration" ? (
          <Configuration model={model} versionId={configurationVersionId} />
        ) : null}
      </PageBody>
    </Page>
  );
}

/** The parsed `ratel.yaml` of one version, the newest when none is chosen. */
function Configuration({
  model,
  versionId,
}: {
  model: SandboxDetailModel;
  versionId: string | null;
}) {
  const router = useRouter();
  const version = model.versions.find((row) => row.id === versionId) ?? model.versions[0];
  if (!version) return null;
  const href = sandboxHref(model.projectId, model.name, "configuration");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="text-ui text-fg-muted">Version</span>
        <Select
          aria-label="Version"
          value={version.id}
          onValueChange={(id) => router.push(`${href}?version=${id}`)}
          options={model.versions.map((row, index) => ({
            value: row.id,
            label: `${index === 0 ? "Newest · " : ""}${row.commit?.slice(0, 12) ?? "no commit"} · ${row.id.slice(0, 8)} · ${VERSION_STATUS[row.status].label}`,
          }))}
          className="w-96"
        />
      </div>
      <VersionConfiguration spec={version.spec} />
    </div>
  );
}
