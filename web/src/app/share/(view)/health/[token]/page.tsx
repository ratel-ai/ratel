import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { HealthPageView } from "@/components/console/health/HealthPageView";
import { SharedPageActions } from "@/components/console/health/share/SharedPageActions";
import { trackProductEvent } from "@/lib/platform/telemetry";
import { hasSignals } from "@/lib/readings/trace-signals/view";
import { shareReportPath } from "@/lib/views/health/share-paths";
import { isLinkPreviewAgent } from "@/lib/views/health/share-preview";
import { recordSharedHealthView, sharedHealthFor } from "@/lib/views/health/shared-page-load";

export const dynamic = "force-dynamic";

/** Placeholder project id: links are off on a shared page, so the real id never reaches the browser. */
const SHARED_PROJECT_ID = "shared";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const shared = await sharedHealthFor((await params).token);
  return {
    title: shared ? `${shared.projectName} · Agent health` : "Agent health",
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

/**
 * The public, read-only Agent health page behind a share link. No session: the token is the only
 * credential, and the model is redacted before it gets here (`publicHealthModel`). Unknown and
 * revoked links, and an edition without share links, are one 404.
 *
 * Owned (ADR-0004): the link is the edition's (`EditionUi.HealthShare`), which resolves the token
 * and counts the view; the rest is upstream's page.
 */
export default async function SharedHealthPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const shared = await sharedHealthFor(token);
  if (!shared) notFound();

  // Link previews (Slack, iMessage, crawlers) load the page too; they are not people opening it.
  const preview = isLinkPreviewAgent((await headers()).get("user-agent"));
  after(async () => {
    if (preview) return;
    await recordSharedHealthView(shared);
    await trackProductEvent(
      "health_share_viewed",
      {
        externalId: `project:${shared.projectId}`,
        orgId: shared.organizationId,
        projectId: shared.projectId,
      },
      { surface: "page", has_signals: hasSignals(shared.model) },
    );
  });

  return (
    <HealthPageView
      projectId={SHARED_PROJECT_ID}
      projectName={shared.projectName}
      model={shared.model}
      windowOptions={[]}
      shared={{ organizationName: shared.organizationName }}
      actions={<SharedPageActions reportHref={shareReportPath(token)} />}
    />
  );
}
