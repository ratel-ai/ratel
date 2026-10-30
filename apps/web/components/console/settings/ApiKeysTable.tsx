"use client";

import { StatusDot } from "@ratel/design-system/badge";
import { Button, IconButton } from "@ratel/design-system/button";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { ConfirmDialog } from "@ratel/design-system/dialog";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  type ApiKeySummary,
  revokeApiKeyAction,
} from "@/app/(console)/project/[projectId]/settings/api-keys/actions";
import { type ApiKeyRow, apiKeyDisplayName, apiKeyRow } from "@/lib/console/settings/api-keys";
import { CreateApiKeyDialog } from "./CreateApiKeyDialog";

/**
 * Settings > API keys: every key the project holds, each
 * revocable on its own, and one primary action to create another. The list
 * comes from the server; the actions revalidate this page, so it redraws
 * with the change. No secret is ever listed: a new key is shown once, in the
 * dialog that created it.
 */
export function ApiKeysTable({
  keys,
  projectSlug,
  organizationId,
  now,
}: {
  keys: readonly ApiKeySummary[];
  projectSlug: string;
  organizationId: string;
  /** ISO time the page was rendered, so relative times agree on server and client. */
  now: string;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  // A new key per opening remounts the dialog, so each starts from a blank form.
  const [createRound, setCreateRound] = useState(0);
  const [revokeOpen, setRevokeOpen] = useState(false);
  // Kept after the dialog closes so its text does not change while it animates out.
  const [revokeTarget, setRevokeTarget] = useState<ApiKeySummary | null>(null);
  const [revoking, setRevoking] = useState(false);
  const rows = useMemo(() => {
    const at = new Date(now);
    return keys.map((key) => apiKeyRow(key, at));
  }, [keys, now]);

  function openCreate() {
    setCreateRound((round) => round + 1);
    setCreateOpen(true);
  }

  // Awaited by ConfirmDialog, so a thrown error reaches its failure toast.
  async function revoke(target: ApiKeySummary) {
    setRevoking(true);
    try {
      const result = await revokeApiKeyAction({ projectSlug, keyId: target.id }, organizationId);
      if (!result.ok) {
        toast({ title: "Couldn't revoke the key", description: result.error, tone: "danger" });
        return;
      }
      setRevokeOpen(false);
      toast({
        title: "API key revoked",
        description: `${apiKeyDisplayName(target)} no longer works.`,
        tone: "success",
      });
    } finally {
      setRevoking(false);
    }
  }

  const columns: readonly Column<ApiKeyRow>[] = [
    {
      id: "name",
      header: "Name",
      cell: (row) => (
        <span className={row.named ? "font-medium text-fg" : "text-fg-muted"}>{row.name}</span>
      ),
    },
    {
      id: "key",
      header: "Key",
      width: "11rem",
      cell: (row) => (
        <code translate="no" className="font-mono text-xs text-fg-muted">
          {row.prefix}…
        </code>
      ),
    },
    {
      id: "created",
      header: "Created",
      width: "8rem",
      cell: (row) => (
        <span title={row.createdTitle} className="whitespace-nowrap text-fg-muted tabular-nums">
          {row.created}
        </span>
      ),
    },
    {
      id: "used",
      header: "Last used",
      width: "7rem",
      cell: (row) => (
        <span
          title={row.lastUsedTitle ?? undefined}
          className="whitespace-nowrap text-fg-muted tabular-nums"
        >
          {row.lastUsed}
        </span>
      ),
    },
    {
      id: "expires",
      header: "Expires",
      width: "8rem",
      cell: (row) => (
        <span className="whitespace-nowrap text-fg-muted tabular-nums">{row.expires}</span>
      ),
    },
    {
      id: "status",
      header: "Status",
      width: "6.5rem",
      cell: (row) => (
        <StatusDot tone={row.status.tone} label={row.status.label} className="whitespace-nowrap" />
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      width: "3rem",
      align: "right",
      cell: (row) => (
        <IconButton
          label={`Revoke ${row.label}`}
          size="icon-sm"
          icon={<Trash2 />}
          onClick={() => {
            const target = keys.find((key) => key.id === row.id);
            if (!target) return;
            setRevokeTarget(target);
            setRevokeOpen(true);
          }}
        />
      ),
    },
  ];

  const createButton = (
    <Button variant="primary" onClick={openCreate}>
      <Plus aria-hidden />
      Create API key
    </Button>
  );

  return (
    <>
      <Section
        title="API keys"
        description="One key per environment or integration, so each can be revoked on its own."
        actions={keys.length > 0 ? createButton : null}
      >
        <DataTable
          caption="API keys"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          empty={
            <EmptyState
              icon={KeyRound}
              title="No API keys yet"
              description="Create one to send traces and SDK events from your agent."
              action={createButton}
            />
          }
        />
      </Section>

      <CreateApiKeyDialog
        key={createRound}
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectSlug={projectSlug}
        organizationId={organizationId}
      />

      <ConfirmDialog
        open={revokeOpen}
        onOpenChange={(open) => {
          if (!revoking) setRevokeOpen(open);
        }}
        title={`Revoke ${revokeTarget ? apiKeyDisplayName(revokeTarget) : "this key"}?`}
        description="Anything still using it stops sending data right away. This can't be undone."
        confirmLabel="Revoke key"
        pending={revoking}
        onConfirm={() => (revokeTarget ? revoke(revokeTarget) : undefined)}
      />
    </>
  );
}
