"use client";

import { Button } from "@ratel/design-system/button";
import { Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Field, Input, Textarea } from "@ratel/design-system/input";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { markFixShippedAction } from "@/app/(console)/project/[projectId]/improvement/fixes/actions";
import type { FixShipped } from "@/lib/views/fixes/shipped";
import { shippedLabel } from "@/lib/views/fixes/shipped";
import type { Fix } from "@/lib/views/fixes/types";

const VERSION_MAX = 100;
const NOTES_MAX = 1000;
const FAILED = "Something went wrong. Nothing changed; try again in a moment.";

/**
 * "Mark as shipped" on a fix's panel, and "Record new release" once it has
 * shipped (a fix can go out in more than one release). The dialog asks for the
 * version and optional notes; the server checks membership and the limits and
 * records the shipment as `mark_fix_shipped` does. After a save the page
 * refreshes, so the fix shows "Shipped in <version>" and Ship lists it.
 */
export function MarkShippedButton({
  projectId,
  fix,
  shipped,
}: {
  projectId: string;
  fix: Pick<Fix, "id" | "title">;
  shipped: FixShipped | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="md" variant="secondary" onClick={() => setOpen(true)}>
        {shipped ? "Record new release" : "Mark as shipped"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {/* Remounted per opening, so every opening starts from an empty form. */}
        {open ? (
          <ShipForm
            key={fix.id}
            projectId={projectId}
            fix={fix}
            shipped={shipped}
            onDone={() => setOpen(false)}
          />
        ) : null}
      </Dialog>
    </>
  );
}

function ShipForm({
  projectId,
  fix,
  shipped,
  onDone,
}: {
  projectId: string;
  fix: Pick<Fix, "id" | "title">;
  shipped: FixShipped | null;
  onDone: () => void;
}) {
  const router = useRouter();
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const trimmed = version.trim();
  const versionError =
    trimmed.length > VERSION_MAX ? `Use ${VERSION_MAX} characters or fewer.` : null;
  const notesError = notes.length > NOTES_MAX ? `Use ${NOTES_MAX} characters or fewer.` : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || trimmed.length === 0 || versionError || notesError) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await markFixShippedAction(projectId, fix.id, trimmed, notes);
        if (!result.ok) {
          setError(result.message);
          return;
        }
        toast({
          title: shippedLabel({ version: result.version }),
          description: "The shipment is on Ship.",
        });
        onDone();
        router.refresh();
      } catch {
        setError(FAILED);
      }
    });
  }

  return (
    <DialogContent
      title={shipped ? "Record a new release" : "Mark as shipped"}
      description={
        shipped
          ? `${fix.title} is live in ${shipped.version}. Record the release that carries it now.`
          : `Record the release that carries "${fix.title}". Ratel deploys nothing.`
      }
      footer={
        <>
          <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
          <Button
            variant="primary"
            type="submit"
            form="mark-shipped-form"
            loading={pending}
            disabled={trimmed.length === 0 || !!versionError || !!notesError}
          >
            Save
          </Button>
        </>
      }
    >
      <form id="mark-shipped-form" onSubmit={submit} className="flex flex-col gap-3">
        <Field
          label="Version"
          description="The agent version or release, e.g. v1.4.2 or a commit sha."
          error={versionError}
        >
          {(control) => (
            <Input
              {...control}
              value={version}
              onChange={(event) => setVersion(event.currentTarget.value)}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          )}
        </Field>
        <Field label="Notes (optional)" error={notesError}>
          {(control) => (
            <Textarea
              {...control}
              value={notes}
              onChange={(event) => setNotes(event.currentTarget.value)}
            />
          )}
        </Field>
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}
      </form>
    </DialogContent>
  );
}
