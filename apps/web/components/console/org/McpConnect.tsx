"use client";

import { Button } from "@ratel/design-system/button";
import { CodeBlock } from "@ratel/design-system/code";
import { Select } from "@ratel/design-system/select";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { KeyRound, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { createApiKeyAction } from "@/app/(console)/project/[projectId]/settings/api-keys/actions";
import {
  buildMcpSnippetSet,
  MCP_CLIENT_LABELS,
  MCP_CLIENTS,
  type McpClient,
} from "@/lib/mcp/connect/snippets";
import { track } from "@/lib/platform/track-client";

const CLIENT_OPTIONS = MCP_CLIENTS.map((client) => ({
  value: client,
  label: MCP_CLIENT_LABELS[client],
}));

/** What each snippet is, on the code block's bar. */
const SNIPPET_KIND: Record<McpClient, string> = {
  "claude-code": "Shell",
  "claude-desktop": "claude_desktop_config.json",
  cursor: "mcp.json",
  cli: "Shell",
};

export interface McpProject {
  id: string;
  name: string;
  slug: string;
}

/**
 * Connect an MCP client. Browser clients sign in, so they need no key. The
 * CI path needs a project key, and since a stored key cannot be shown again,
 * the button mints one and fills it into the snippet: the single moment its
 * plaintext exists.
 */
export function McpConnect({
  endpoint,
  organizationId,
  organizationSlug,
  projects,
  keyPrefixesByProject,
  restricted,
}: {
  endpoint: string;
  organizationId: string;
  organizationSlug: string;
  projects: readonly McpProject[];
  /** Live key prefixes per project id; never the secrets. */
  keyPrefixesByProject: Readonly<Record<string, readonly string[]>>;
  /** Inside an admin support session no key is minted. */
  restricted: boolean;
}) {
  const [client, setClient] = useState<McpClient>("claude-code");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  // Held for this page view only, never stored or fetched again.
  const [mintedKey, setMintedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const project = projects.find((candidate) => candidate.id === projectId);
  const prefixes = keyPrefixesByProject[projectId] ?? [];
  const snippets = useMemo(
    () => buildMcpSnippetSet({ endpoint, apiKey: mintedKey }),
    [endpoint, mintedKey],
  );
  const { note, code, auth } = snippets[client];
  const keysHref = project
    ? `/project/${encodeURIComponent(project.id)}/settings/api-keys`
    : `/org/${encodeURIComponent(organizationSlug)}`;

  function mint() {
    if (!project) {
      setError("Create a project first: an API key belongs to one.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createApiKeyAction(
        { projectSlug: project.slug, name: "MCP", expiresIn: "never" },
        organizationId,
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMintedKey(result.plaintext);
      track("mcp_key_created", { had_existing_key: prefixes.length > 0 });
    });
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SegmentedControl
        label="MCP client"
        options={CLIENT_OPTIONS}
        value={client}
        onValueChange={(next) => {
          setClient(next);
          track("mcp_client_selected", { client: next });
        }}
        className="self-start"
      />

      {auth === "oauth" ? (
        <p className="flex items-start gap-2 text-ui text-fg-muted">
          <ShieldCheck
            aria-hidden
            strokeWidth={1.5}
            className="mt-0.5 size-4 shrink-0 text-fg-subtle"
          />
          No API key needed. Your client opens a browser, you sign in, and it reaches every project
          you belong to.
        </p>
      ) : (
        <div className="flex flex-col gap-3 rounded-lg border border-line px-4 py-3">
          <p className="flex items-start gap-2 text-ui text-fg-muted">
            <KeyRound
              aria-hidden
              strokeWidth={1.5}
              className="mt-0.5 size-4 shrink-0 text-fg-subtle"
            />
            <span>
              {mintedKey
                ? "A new key is filled in below. This is the only time it is shown, so copy the snippet now."
                : projects.length === 0
                  ? "This organization has no projects yet, and a key belongs to one."
                  : prefixes.length > 0
                    ? `This project has ${prefixes.length === 1 ? "a key" : `${prefixes.length} keys`} (${prefixes.join(", ")}). Stored keys can't be shown again.`
                    : "This project has no API key yet, and the server needs one."}
            </span>
          </p>
          {projects.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label="Project the key belongs to"
                options={projects.map((candidate) => ({
                  value: candidate.id,
                  label: candidate.name,
                }))}
                value={projectId}
                onValueChange={(next) => {
                  setProjectId(next);
                  // A minted key belongs to the project it was made for.
                  setMintedKey(null);
                  setError(null);
                }}
                className="min-w-48"
              />
              {mintedKey ? null : (
                <Button loading={pending} disabled={restricted} onClick={mint}>
                  {pending ? "Creating…" : "Create a key and fill it in"}
                </Button>
              )}
              <Link
                href={keysHref}
                className="rounded-md px-1 text-ui text-fg-muted underline decoration-line-strong underline-offset-4 outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
              >
                Manage keys
              </Link>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
        </div>
      )}

      {note ? <p className="text-xs text-fg-subtle">{note}</p> : null}
      <CodeBlock
        caption={SNIPPET_KIND[client]}
        samples={[{ label: MCP_CLIENT_LABELS[client], code }]}
        onCopy={() => track("mcp_snippet_copied", { client })}
      />
    </div>
  );
}
