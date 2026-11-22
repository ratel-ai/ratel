import { buttonVariants } from "@ratel/design-system/button-variants";
import { CodeBlock } from "@ratel/design-system/code";
import { PageBody } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { Callout } from "@ratel/design-system/states";
import { ExternalLink, GitBranch } from "lucide-react";
import type { SessionContext } from "@/lib/platform/session";
import { readGitHubAppConfig } from "@/lib/views/code-handoff/config";
import { loadRepositoryView, type SetupHint } from "@/lib/views/code-handoff/repository-view";
import { linkServiceDepsFor } from "@/lib/views/code-handoff/wiring";
import { RepoPicker } from "./RepoPicker";
import { UnlinkRepo } from "./UnlinkRepo";

/**
 * Project settings › Repository (RC-914): the one GitHub repo this project is
 * linked to through the Ratel GitHub App. Not configured, not connected
 * (Install), picking a repo after GitHub's redirect, or linked (Unlink).
 */
export async function RepositorySettings({
  session,
  projectId,
  grant,
  setupError,
}: {
  session: SessionContext;
  projectId: string;
  grant: string | null;
  setupError: string | null;
}) {
  const view = await loadRepositoryView(
    {
      actor: { projectId, externalId: session.user.externalId },
      appSlug: readGitHubAppConfig()?.slug ?? null,
      grant,
      setupError,
    },
    linkServiceDepsFor(session),
  );

  return (
    <PageBody className="flex max-w-3xl flex-col gap-8 *:min-w-0">
      {view.state === "not_configured" ? (
        <Callout tone="warning" title="GitHub App not configured">
          This deployment has no Ratel GitHub App settings, so a repository cannot be linked yet.
        </Callout>
      ) : null}

      {view.state === "not_connected" || view.state === "picking" ? (
        <Section
          title="GitHub repository"
          description="Link the repository of this project's agent. Ratel opens an issue there for each fix you hand off."
          actions={
            <a
              href={view.installUrl}
              className={buttonVariants({
                variant: view.state === "picking" ? "secondary" : "primary",
              })}
            >
              {view.state === "picking" ? "Change access on GitHub" : "Install the GitHub App"}
            </a>
          }
        >
          {view.error ? <Callout tone="danger">{view.error}</Callout> : null}
          {view.state === "picking" ? (
            <RepoPicker
              projectId={projectId}
              grant={view.grant}
              repos={view.repos.map((repo) => ({ id: repo.id, fullName: repo.fullName }))}
            />
          ) : (
            <p className="text-sm text-fg-muted">
              Install the App on GitHub, choose the repository, and come back here to link it.
              Already installed?{" "}
              <a href={view.authorizeUrl} className="font-medium text-fg hover:underline">
                Connect your GitHub account
              </a>
              .
            </p>
          )}
        </Section>
      ) : null}

      {view.state === "linked" ? (
        <>
          <Section title="GitHub repository" actions={<UnlinkRepo projectId={projectId} />}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line bg-raised px-4 py-3 text-sm">
              <a
                href={view.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 font-medium text-fg hover:underline"
              >
                {view.link.owner}/{view.link.name}
                <ExternalLink className="size-3.5 text-fg-subtle" aria-hidden />
              </a>
              <span className="inline-flex items-center gap-1 text-fg-muted">
                <GitBranch className="size-3.5" aria-hidden />
                {view.link.defaultBranch}
              </span>
            </div>
          </Section>
          <SetupHintSection hint={view.hint} />
        </>
      ) : null}
    </PageBody>
  );
}

/** The two things the repository needs for the handoff to work end to end. */
function SetupHintSection({ hint }: { hint: SetupHint }) {
  return (
    <Section title="Finish the setup in your repository">
      <ol className="flex list-decimal flex-col gap-4 pl-5 text-sm text-fg-muted">
        <li>
          Set <code className="font-mono text-fg">service.version</code> to the commit SHA of each
          deploy, for example <code className="font-mono text-fg">GITHUB_SHA</code>. Ratel matches a
          deploy to the fixes it carries by that SHA.
        </li>
        <li>
          Let the Claude Code GitHub Action act on the issues the Ratel App opens: add its bot to{" "}
          <code className="font-mono text-fg">allowed_bots</code>.
          <CodeBlock
            samples={[
              {
                label: "claude.yml",
                code: `- uses: anthropics/claude-code-action@v1\n  with:\n    allowed_bots: "${hint.botLogin}"`,
              },
            ]}
            className="mt-2"
          />
        </li>
      </ol>
    </Section>
  );
}
