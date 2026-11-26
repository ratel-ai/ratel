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
/** A short `ratel.yaml`: what a version declares, so the run panel can show it. */
const RATEL_YAML = `name: support-agent
image:
  dockerfile: Dockerfile
input:
  example: { message: "Where is my order 7?" }
params:
  model:
    type: enum
    options: [small, large]
    default: small
tools:
  refund_order: { mode: simulated }
secrets: [OPENAI_API_KEY]`;

/** The Ratel sandbox page: a run by hand first, then the push, the versions and the secrets. */
export function SandboxView({
  model,
  ratelUrl,
  canSaveCases = false,
  now,
}: {
  model: SandboxPageModel;
  /** The address that a push goes to. */
  ratelUrl: string;
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
        title="Ratel sandbox"
        description="Ratel builds your agent from your repository and runs it. A tool with side effects does not run for real."
      />
      <PageBody>
        {model.problems.length > 0 ? (
          <Callout
            tone="warning"
            title={
              model.configured
                ? "A setting of this server is missing"
                : "Ratel sandbox is not configured"
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
        ) : null}
        <SandboxRunOnce
          projectId={model.projectId}
          versions={model.versions}
          runs={model.runs}
          canSaveCases={canSaveCases}
          configured={model.configured}
          now={now}
        />
        <Section
          title="Push"
          description="Run this in the folder of your agent, next to ratel.yaml. Each push makes a new version."
        >
          <CodeBlock
            samples={[
              {
                label: "Shell",
                code: `export RATEL_URL=${ratelUrl}\nexport RATEL_API_KEY=<a key with full access>\nratel push`,
              },
              { label: "ratel.yaml", code: RATEL_YAML },
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
      </PageBody>
    </Page>
  );
}
