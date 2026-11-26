"use client";

import { CodeBlock } from "@ratel/design-system/code";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { Callout } from "@ratel/design-system/states";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { SandboxPageModel } from "@/lib/views/sandboxes/page-model";
import { SandboxRunOnce } from "./SandboxRunOnce";
import { SandboxSecrets } from "./SandboxSecrets";
import { SandboxVersions } from "./SandboxVersions";

const REFRESH_MS = 3_000;

/** The Ratel sandbox page: the versions, the secrets and one run by hand. */
export function SandboxView({
  model,
  ratelUrl,
  now,
}: {
  model: SandboxPageModel;
  /** The address that a push goes to. */
  ratelUrl: string;
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
        title="Ratel sandbox"
        description="Ratel builds your agent from your repository and runs it. A tool with side effects does not run for real."
      />
      <PageBody>
        {model.configured ? null : (
          <Callout tone="warning" title="Ratel sandbox is not configured">
            This deployment has no account to build and run sandboxes. A push is refused until an
            operator sets it up.
          </Callout>
        )}
        <Section
          title="Push"
          description="Run this in the folder of your agent, next to ratel.sandbox.ts. Each push makes a new version."
        >
          <CodeBlock
            samples={[
              {
                label: "Shell",
                code: `export RATEL_URL=${ratelUrl}\nexport RATEL_API_KEY=<a key with full access>\nratel sandbox push`,
              },
            ]}
          />
        </Section>
        <SandboxVersions versions={model.versions} now={now} />
        <SandboxSecrets
          projectId={model.projectId}
          secrets={model.secrets}
          canEdit={model.canEdit}
          now={now}
        />
        <SandboxRunOnce
          projectId={model.projectId}
          versions={model.versions}
          runs={model.runs}
          configured={model.configured}
          now={now}
        />
      </PageBody>
    </Page>
  );
}
