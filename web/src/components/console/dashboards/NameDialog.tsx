"use client";

import { Button } from "@ratel/design-system/button";
import { Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Field, Input } from "@ratel/design-system/input";
import { useId, useState } from "react";
import { MAX_DASHBOARD_NAME } from "@/lib/views/dashboards/types";

/** Name a new dashboard, or rename one. */
export function NameDialog({
  open,
  onOpenChange,
  title,
  submitLabel,
  initial = "",
  saving,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  submitLabel: string;
  initial?: string;
  saving: boolean;
  onSubmit: (name: string) => void;
}) {
  const formId = useId();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={title}
        footer={
          <>
            <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
            <Button type="submit" form={formId} variant="primary" loading={saving}>
              {submitLabel}
            </Button>
          </>
        }
      >
        <NameForm id={formId} initial={initial} onSubmit={onSubmit} />
      </DialogContent>
    </Dialog>
  );
}

/** Inside the popup, so every open starts from the current name. */
function NameForm({
  id,
  initial,
  onSubmit,
}: {
  id: string;
  initial: string;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <form
      id={id}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(name);
      }}
    >
      <Field label="Name">
        {(control) => (
          <Input
            {...control}
            value={name}
            required
            maxLength={MAX_DASHBOARD_NAME}
            autoComplete="off"
            placeholder="Support agent"
            onChange={(event) => setName(event.currentTarget.value)}
          />
        )}
      </Field>
    </form>
  );
}
