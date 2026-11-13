"use client";

import { Button } from "@ratel/design-system/button";
import { ConfirmDialog } from "@ratel/design-system/dialog";
import { toast } from "@ratel/design-system/toast";
import { useState } from "react";
import { deleteProjectAction } from "@/app/(console)/project/[projectId]/settings/danger/actions";
import { settleRedirectingAction } from "@/lib/console/settings/redirect";
import { DangerRow } from "./DangerRow";

/**
 * Delete the project, after its name is typed (DESIGN.md, Destructive
 * actions). What the person typed goes to the server, which checks it, as in
 * v1. The action redirects on success, and the button keeps its spinner while
 * the page leaves; a refusal is a toast, and a thrown error falls through to
 * ConfirmDialog's own failure toast.
 */
export function DeleteProject({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove(typed: string) {
    setBusy(true);
    let navigated = false;
    try {
      const outcome = await settleRedirectingAction(() =>
        deleteProjectAction(projectId, typed.trim()),
      );
      navigated = outcome.navigated;
      if (!outcome.navigated && outcome.error) {
        toast({ title: "Couldn't delete the project", description: outcome.error, tone: "danger" });
      }
    } finally {
      // Leaving the page: keep the spinner until the next page replaces this one.
      if (!navigated) setBusy(false);
    }
  }

  return (
    <>
      <DangerRow
        action={
          <Button onClick={() => setOpen(true)} className="text-danger">
            Delete project…
          </Button>
        }
      >
        Deletes <span className="font-medium text-fg">{projectName}</span> with its API keys and
        every event it received.
      </DangerRow>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
        title={`Delete ${projectName}?`}
        description="Its API keys, traces and events are deleted for good. This can't be undone."
        confirmLabel="Delete project"
        requireText={projectName}
        pending={busy}
        onConfirm={remove}
      />
    </>
  );
}
