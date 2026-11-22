import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { notFound, redirect } from "next/navigation";
import { ConnectRunner } from "@/components/console/sandboxes/ConnectRunner";
import { RunnerStatus } from "@/components/console/sandboxes/RunnerStatus";
import { SandboxPlayground } from "@/components/console/sandboxes/SandboxPlayground";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { sandboxesEnabledForProject } from "@/lib/platform/sandboxes-flag";
import { getSessionContext } from "@/lib/platform/session";
import { loadSandboxPage } from "@/lib/views/sandboxes/page";
import { sandboxesPageDeps, sessionReplayDeps } from "@/lib/views/sandboxes/page-deps";
import { loadSessionReplay } from "@/lib/views/sandboxes/replay/session-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sandbox" };

/** One sandbox's playground (RC-1102, spec §9). 404 unless `cloud-sandboxes` is on. */
export default async function SandboxPlaygroundPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; sandboxId: string }>;
  searchParams: Promise<{ span?: string | string[]; session?: string | string[] }>;
}) {
  if (!isDbConfigured()) notFound();
  const context = await getSessionContext();
  if (!context) redirect("/");
  const { projectId, sandboxId: rawSandboxId } = await params;
  const { project } = await getProjectScope(projectId);
  if (!(await sandboxesEnabledForProject(project.id))) notFound();
  const sandboxId = safeDecode(rawSandboxId);
  // "Open in sandbox" (RC-1103): `?span=` names the recorded item to open.
  const query = await searchParams;
  const span = query.span;
  // "Replay in sandbox" (RC-1110): `?session=` names the recorded session to replay.
  const sessionId =
    typeof query.session === "string" && query.session.length > 0 && query.session.length <= 256
      ? query.session
      : null;
  const spanId = typeof span === "string" && /^[0-9a-f]{1,64}$/i.test(span) ? span : null;
  const model = await loadSandboxPage(
    { projectId: project.id, externalId: context.user.externalId, sandboxId, spanId },
    sandboxesPageDeps,
  );
  const crumbs = [
    { label: "Sandboxes", href: `/project/${encodeURIComponent(project.id)}/sandboxes` },
  ];

  if (!model.runner || !model.sandbox) {
    return (
      <Page>
        <PageHeader
          title={sandboxId}
          crumbs={crumbs}
          actions={<RunnerStatus runner={model.runner} />}
        />
        <PageBody>
          {model.runner ? (
            <p className="py-12 text-center text-sm text-fg-muted">
              Your runner has no sandbox named{" "}
              <code className="font-mono text-xs text-fg">{sandboxId}</code>. Check the sandbox id
              in your .sandbox.ts file.
            </p>
          ) : (
            <ConnectRunner />
          )}
        </PageBody>
      </Page>
    );
  }

  const replay = sessionId
    ? await loadSessionReplay(
        {
          projectId: project.id,
          sessionId,
          sandbox: { id: model.sandbox.id, inputKind: model.sandbox.input.kind },
        },
        sessionReplayDeps,
      )
    : null;

  return (
    <SandboxPlayground
      projectId={project.id}
      crumbs={crumbs}
      runner={model.runner}
      sandbox={model.sandbox}
      providers={model.providers}
      defaultConfigHash={model.defaultConfigHash}
      productionHash={model.productionHash}
      initialItem={model.item}
      initialReplay={replay}
    />
  );
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A segment Next already decoded can hold a bare "%": it is the id as is.
    return segment;
  }
}
