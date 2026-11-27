"use client";

import { Button } from "@ratel/design-system/button";
import { Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Field, Textarea } from "@ratel/design-system/input";
import { Callout } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { FileJson } from "lucide-react";
import { useId, useRef, useState, useTransition } from "react";
import { changeDashboardAction } from "@/app/(console)/project/[projectId]/dashboards/actions";

/** A dashboard from its JSON document: a file, or pasted. */
export function ImportDialog({
  open,
  onOpenChange,
  projectId,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onImported: (dashboardId: string) => void;
}) {
  const formId = useId();
  const [saving, startSave] = useTransition();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Import dashboard"
        footer={
          <>
            <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
            <Button type="submit" form={formId} variant="primary" loading={saving}>
              Import
            </Button>
          </>
        }
      >
        <ImportForm
          id={formId}
          onSubmit={(json, refuse) =>
            startSave(async () => {
              const result = await imported(projectId, json);
              if (!result.ok) return refuse(result.error);
              if (result.missingScorers)
                toast({
                  title: `Imported. This project has no scorer named ${result.missingScorers
                    .map((name) => `"${name}"`)
                    .join(", ")}.`,
                  tone: "danger",
                });
              onImported(result.dashboardId);
            })
          }
        />
      </DialogContent>
    </Dialog>
  );
}

/** Inside the popup, so every open starts empty. */
function ImportForm({
  id,
  onSubmit,
}: {
  id: string;
  onSubmit: (json: string, refuse: (error: string) => void) => void;
}) {
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <form
      id={id}
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        onSubmit(json, setError);
      }}
    >
      <div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => fileRef.current?.click()}
        >
          <FileJson className="size-3.5" aria-hidden />
          Choose a file
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          aria-label="Dashboard file"
          className="hidden"
          onChange={async (event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) setJson(await file.text());
          }}
        />
      </div>
      <Field label="Dashboard JSON">
        {(control) => (
          <Textarea
            {...control}
            value={json}
            required
            rows={12}
            spellCheck={false}
            className="font-mono text-xs"
            onChange={(event) => setJson(event.currentTarget.value)}
          />
        )}
      </Field>
      {error ? (
        <Callout tone="danger" title="The dashboard was not imported">
          {error}
        </Callout>
      ) : null}
    </form>
  );
}

async function imported(projectId: string, json: string) {
  let document: unknown;
  try {
    document = JSON.parse(json);
  } catch {
    return { ok: false as const, error: "The text is not valid JSON." };
  }
  try {
    return await changeDashboardAction({ projectId, action: "import", document });
  } catch {
    return { ok: false as const, error: "Could not import the dashboard. Try again." };
  }
}
