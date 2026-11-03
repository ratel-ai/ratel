"use client";

import { Button } from "@ratel/design-system/button";
import { ConfirmDialog } from "@ratel/design-system/dialog";
import { toast } from "@ratel/design-system/toast";
import { type ReactNode, useState } from "react";
import { deleteOrganizationAction } from "@/app/(console)/org/[orgSlug]/settings/danger/actions";
import { DangerRow } from "@/components/console/settings/DangerRow";
import { settleRedirectingAction } from "@/lib/console/settings/redirect";

/**
 * Delete the organization after its name is typed; the typed text goes to the
 * server, which checks it, as in v1. A paid organization is refused by the
 * action until its subscription is canceled, so the button is off then and
 * the row says why. Success redirects; a refusal is a toast; a thrown error
 * falls through to ConfirmDialog's failure toast.
 */
export function DeleteOrganization({
  organizationId,
  organizationName,
  blockedReason,
}: {
  organizationId: string;
  organizationName: string;
  /** Why deleting is off right now (a live subscription, a support session), or null. */
  blockedReason: ReactNode | null;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove(typed: string) {
    setBusy(true);
    let navigated = false;
    try {
      const outcome = await settleRedirectingAction(() =>
        deleteOrganizationAction(organizationId, typed.trim()),
      );
      navigated = outcome.navigated;
      if (!outcome.navigated && outcome.error) {
        toast({
          title: "Couldn't delete the organization",
          description: outcome.error,
          tone: "danger",
        });
      }
    } finally {
      if (!navigated) setBusy(false);
    }
  }

  return (
    <>
      <DangerRow
        action={
          <Button
            onClick={() => setOpen(true)}
            disabled={blockedReason !== null}
            className="text-danger"
          >
            Delete organization…
          </Button>
        }
      >
        {blockedReason ?? (
          <>
            Deletes <span className="font-medium text-fg">{organizationName}</span> with every
            project, API key, event, member and invitation in it.
          </>
        )}
      </DangerRow>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
        title={`Delete ${organizationName}?`}
        description="Every project, key, event and membership in it is deleted for good. This can't be undone."
        confirmLabel="Delete organization"
        requireText={organizationName}
        pending={busy}
        onConfirm={remove}
      />
    </>
  );
}
