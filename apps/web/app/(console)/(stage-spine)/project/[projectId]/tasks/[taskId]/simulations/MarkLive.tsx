"use client";

import { Button } from "@ratel/design-system/button";
import { Dialog, DialogContent } from "@ratel/design-system/dialog";
import { Field, Input, Textarea } from "@ratel/design-system/input";
import { type FormEvent, useState } from "react";
import { type SimulationScope, useSimulationAction } from "./SimulationControls";

export function MarkLive({ scope }: { scope: SimulationScope }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Mark as live</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? <MarkLiveForm scope={scope} onDone={() => setOpen(false)} /> : null}
      </Dialog>
    </>
  );
}

function MarkLiveForm({ scope, onDone }: { scope: SimulationScope; onDone(): void }) {
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState("");
  const { busy, submit } = useSimulationAction(scope);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (await submit({ action: "mark-live", version, notes })) onDone();
  }
  return (
    <DialogContent
      title="Mark as live"
      description="Record the version you released. Ratel measures each task after 20 completed runs or 7 days."
    >
      <form onSubmit={save} className="flex flex-col gap-4">
        <Field label="Version" description="Use a release version or commit ID.">
          {(control) => (
            <Input
              {...control}
              required
              maxLength={200}
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              autoComplete="off"
            />
          )}
        </Field>
        <Field label="Notes" description="Optional. Describe the release.">
          {(control) => (
            <Textarea
              {...control}
              maxLength={10000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onDone} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            Mark as live
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
