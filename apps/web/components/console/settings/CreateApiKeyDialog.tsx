"use client";

import { Button } from "@ratel/design-system/button";
import { KeyReveal } from "@ratel/design-system/code";
import { Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Field, Input } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { type FormEvent, useId, useState, useTransition } from "react";
import { createApiKeyAction } from "@/app/(console)/project/[projectId]/settings/api-keys/actions";
import { newKeyCloseDecision } from "@/lib/console/settings/api-keys";
import {
  API_KEY_EXPIRY_CHOICES,
  API_KEY_NAME_MAX_LEN,
  type ApiKeyExpiryPreset,
  DEFAULT_API_KEY_EXPIRY,
} from "@/lib/platform/api-keys";

const EXPIRY_OPTIONS = API_KEY_EXPIRY_CHOICES.map((choice) => ({
  value: choice.value,
  label: choice.label,
}));

/**
 * Create an API key in two steps on one dialog: the name and lifetime, then
 * the new key, shown once with a copy button. That step holds the only copy,
 * so a click outside cannot close it, and Esc or the close button ask once
 * before an uncopied key is let go. The plaintext leaves state as soon as the
 * dialog has closed; the server never returns it again. The parent remounts
 * this per opening (a `key`), so every opening starts from an empty form.
 */
export function CreateApiKeyDialog({
  open,
  onOpenChange,
  projectSlug,
  organizationId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectSlug: string;
  organizationId: string;
}) {
  const formId = useId();
  const [name, setName] = useState("");
  const [expiresIn, setExpiresIn] = useState<ApiKeyExpiryPreset>(DEFAULT_API_KEY_EXPIRY);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ plaintext: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [asking, setAsking] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    startTransition(async () => {
      const result = await createApiKeyAction({ projectSlug, name, expiresIn }, organizationId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCreated({ plaintext: result.plaintext, label: result.key.name ?? "New API key" });
    });
  }

  function requestOpenChange(next: boolean) {
    if (next || !created) {
      if (!pending) onOpenChange(next);
      return;
    }
    if (newKeyCloseDecision({ copied, asking }) === "ask") {
      setAsking(true);
      return;
    }
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={requestOpenChange}
      disablePointerDismissal={created !== null}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen) return;
        // The only copy of the key goes with the dialog.
        setCreated(null);
        setCopied(false);
        setAsking(false);
      }}
    >
      {created && asking ? (
        <DialogContent
          title="Close without copying the key?"
          description="It is shown only this once. Once closed, create a new key if you need one."
          footer={
            <>
              <Button variant="secondary" onClick={() => setAsking(false)}>
                Show the key
              </Button>
              <Button variant="danger" onClick={() => onOpenChange(false)}>
                Close without copying
              </Button>
            </>
          }
        />
      ) : created ? (
        <DialogContent
          title="Copy your new key"
          description="This is the only time the full key is shown. Keep it somewhere safe."
          footer={
            <Button variant="primary" onClick={() => requestOpenChange(false)}>
              Done
            </Button>
          }
        >
          <KeyReveal
            value={created.plaintext}
            label={created.label}
            onCopy={() => setCopied(true)}
          />
          <p className="text-xs text-fg-subtle">
            Set it as <code className="font-mono text-fg-muted">RATEL_API_KEY</code> where your
            agent runs.
          </p>
        </DialogContent>
      ) : (
        <DialogContent
          title="Create API key"
          description="Keys you already use keep working."
          footer={
            <>
              <DialogClose render={<Button variant="secondary" />} disabled={pending}>
                Cancel
              </DialogClose>
              <Button type="submit" form={formId} variant="primary" loading={pending}>
                {pending ? "Creating…" : "Create API key"}
              </Button>
            </>
          }
        >
          <form id={formId} onSubmit={submit} className="flex flex-col gap-4">
            <Field label="Name" description="Optional. The environment or integration it is for.">
              {(control) => (
                <Input
                  {...control}
                  name="name"
                  value={name}
                  maxLength={API_KEY_NAME_MAX_LEN}
                  placeholder="Staging"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setName(event.currentTarget.value)}
                />
              )}
            </Field>
            <Field label="Expires">
              {(control) => (
                <Select
                  id={control.id}
                  options={EXPIRY_OPTIONS}
                  value={expiresIn}
                  onValueChange={(value) => setExpiresIn(value as ApiKeyExpiryPreset)}
                  disabled={pending}
                  className="w-full"
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
      )}
    </Dialog>
  );
}
