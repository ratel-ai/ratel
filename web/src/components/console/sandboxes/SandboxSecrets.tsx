"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { ConfirmDialog } from "@ratel/design-system/dialog";
import { Field, Input } from "@ratel/design-system/input";
import { Section } from "@ratel/design-system/section";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import type { SecretRow } from "@/lib/views/sandboxes/page-model";

/** The secrets by name. A value goes in and is never shown again. */
export function SandboxSecrets({
  projectId,
  secrets,
  canEdit,
  now,
}: {
  projectId: string;
  secrets: SecretRow[];
  canEdit: boolean;
  now: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  async function send(secret: string, init: RequestInit): Promise<boolean> {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/sandboxes/secrets/${encodeURIComponent(secret)}`,
        init,
      );
      if (response.ok) {
        router.refresh();
        return true;
      }
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      setError(body?.message ?? "The change was not saved. Try again.");
    } catch {
      setError("The change was not saved. Try again.");
    } finally {
      setPending(false);
    }
    return false;
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const secret = name.trim();
    if (!secret || !value || pending) return;
    const saved = await send(secret, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    });
    if (!saved) return;
    setName("");
    setValue("");
    toast({ title: "Secret saved", description: `${secret} is set.`, tone: "success" });
  }

  return (
    <Section
      title="Secrets"
      description="Your agent reads them from its environment. Ratel never shows a value again."
    >
      {secrets.length > 0 ? (
        <ul className="divide-y divide-line rounded-lg border border-line bg-raised">
          {secrets.map((secret) => (
            <li key={secret.name} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <code className="font-mono text-ui text-fg">{secret.name}</code>
              {secret.updatedAt ? (
                <span className="text-xs text-fg-subtle">
                  set {formatRelativeTime(secret.updatedAt, now)}
                </span>
              ) : (
                <Badge tone="warning">Missing</Badge>
              )}
              {secret.declared ? null : (
                <span className="text-xs text-fg-faint">not in the latest version</span>
              )}
              {canEdit ? (
                <span className="ml-auto flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setName(secret.name)}>
                    {secret.updatedAt ? "Replace" : "Set"}
                  </Button>
                  {secret.updatedAt ? (
                    <Button size="sm" variant="ghost" onClick={() => setRemoving(secret.name)}>
                      Delete
                    </Button>
                  ) : null}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canEdit ? (
        <form
          onSubmit={save}
          className="flex flex-wrap items-start gap-3"
          aria-label="Set a secret"
        >
          <Field label="Name" className="w-64" error={error}>
            {(control) => (
              <Input
                {...control}
                value={name}
                placeholder="OPENAI_API_KEY"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <Field label="Value" className="w-72">
            {(control) => (
              <Input
                {...control}
                type="password"
                value={value}
                autoComplete="new-password"
                onChange={(event) => setValue(event.target.value)}
              />
            )}
          </Field>
          <Button type="submit" className="mt-5" disabled={pending || !name.trim() || !value}>
            Save secret
          </Button>
        </form>
      ) : (
        <p className="text-xs text-fg-subtle">Only organization admins can change secrets.</p>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
        title={`Delete ${removing ?? "the secret"}?`}
        description="A run of a version that needs it is refused until you set it again."
        confirmLabel="Delete secret"
        pending={pending}
        onConfirm={async () => {
          if (removing) await send(removing, { method: "DELETE" });
          setRemoving(null);
        }}
      />
    </Section>
  );
}
