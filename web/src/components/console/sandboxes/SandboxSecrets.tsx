"use client";

import { Badge, type Tone } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { ConfirmDialog } from "@ratel/design-system/dialog";
import { Field, Input } from "@ratel/design-system/input";
import { Section } from "@ratel/design-system/section";
import { toast } from "@ratel/design-system/toast";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState } from "react";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import type {
  ProjectSecretRow,
  SandboxDetailModel,
  SandboxSecretRow,
} from "@/lib/views/sandboxes/page-model";
import { projectSecretsHref, sandboxHref } from "@/lib/views/sandboxes/paths";

/** A row of a secrets list: a name, what gives its value, and whether this level has a value. */
type Row = { name: string; badge: ReactNode; detail: ReactNode; hasValue: boolean };

const SOURCE: Record<SandboxSecretRow["source"], { label: string; tone: Tone }> = {
  sandbox: { label: "Sandbox value", tone: "accent" },
  project: { label: "Project value", tone: "neutral" },
  missing: { label: "Missing", tone: "warning" },
};

/**
 * The project level: a value here applies to each sandbox that declares the name and has no value
 * of its own. A value goes in and is never shown again.
 */
export function ProjectSecrets({
  projectId,
  secrets,
  canEdit,
  now,
}: {
  projectId: string;
  secrets: ProjectSecretRow[];
  canEdit: boolean;
  now: string;
}) {
  const rows: Row[] = secrets.map((secret) => ({
    name: secret.name,
    hasValue: secret.updatedAt !== null,
    badge: secret.updatedAt ? null : <Badge tone="warning">No project value</Badge>,
    detail: (
      <>
        {secret.updatedAt ? `set ${formatRelativeTime(secret.updatedAt, now)}` : null}
        {secret.updatedAt && secret.declaredBy.length > 0 ? " · " : null}
        {secret.declaredBy.length > 0
          ? `used by ${secret.declaredBy.join(", ")}`
          : "no sandbox declares it"}
      </>
    ),
  }));
  return (
    <div id="project-secrets" className="scroll-mt-16">
      <SecretsEditor
        title="Project secrets"
        description="Each sandbox of the project gets these values. A sandbox value of the same name wins."
        endpoint={(name) =>
          `/api/projects/${projectId}/sandboxes/secrets/${encodeURIComponent(name)}`
        }
        rows={rows}
        canEdit={canEdit}
        removeText="A sandbox that declares it and has no value of its own is refused until you set it again."
      />
    </div>
  );
}

/** The level of one sandbox: each declared name with its source, and the sandbox values. */
export function SandboxSecrets({
  model,
  now,
}: {
  model: Pick<SandboxDetailModel, "projectId" | "name" | "secrets" | "undeclared" | "canEdit">;
  now: string;
}) {
  const { projectId, name: sandbox } = model;
  const rows: Row[] = [
    ...model.secrets.map((secret) => ({
      name: secret.name,
      hasValue: secret.source === "sandbox",
      badge: <Badge tone={SOURCE[secret.source].tone}>{SOURCE[secret.source].label}</Badge>,
      detail: secret.updatedAt ? `set ${formatRelativeTime(secret.updatedAt, now)}` : null,
    })),
    ...model.undeclared.map((secret) => ({
      name: secret.name,
      hasValue: true,
      badge: <Badge tone="neutral">Not declared</Badge>,
      detail: "the newest version does not declare it",
    })),
  ];
  return (
    <SecretsEditor
      title="Secrets"
      description={
        <>
          The names that <code className="font-mono text-xs">ratel.yaml</code> declares. A value set
          here wins over the value of the{" "}
          <Link href={projectSecretsHref(projectId)} className="text-fg underline">
            project secrets
          </Link>
          .
        </>
      }
      endpoint={(name) =>
        `/api/projects/${projectId}/sandboxes/by-name/${encodeURIComponent(sandbox)}/secrets/${encodeURIComponent(name)}`
      }
      rows={rows}
      canEdit={model.canEdit}
      setLabel="Set for this sandbox"
      removeText="The project value applies again. With no project value, a run is refused until you set one."
      footer={
        <p className="text-xs text-fg-subtle">
          A run is refused while a declared name is missing, and the refusal names it.{" "}
          <Link href={sandboxHref(projectId, sandbox, "configuration")} className="underline">
            See the configuration
          </Link>
          .
        </p>
      }
    />
  );
}

/** A list of names with set, replace and delete for one level. */
function SecretsEditor({
  title,
  description,
  endpoint,
  rows,
  canEdit,
  setLabel = "Set",
  removeText,
  footer,
}: {
  title: string;
  description: ReactNode;
  endpoint: (name: string) => string;
  rows: Row[];
  canEdit: boolean;
  setLabel?: string;
  removeText: string;
  footer?: ReactNode;
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
      const response = await fetch(endpoint(secret), init);
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
    <Section title={title} description={description}>
      {rows.length > 0 ? (
        <ul className="divide-y divide-line rounded-lg border border-line bg-raised">
          {rows.map((row) => (
            <li key={row.name} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <code className="font-mono text-ui text-fg">{row.name}</code>
              {row.badge}
              {row.detail ? <span className="text-xs text-fg-subtle">{row.detail}</span> : null}
              {canEdit ? (
                <span className="ml-auto flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setName(row.name)}>
                    {row.hasValue ? "Replace" : setLabel}
                  </Button>
                  {row.hasValue ? (
                    <Button size="sm" variant="ghost" onClick={() => setRemoving(row.name)}>
                      Delete
                    </Button>
                  ) : null}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ui text-fg-subtle">No secret yet.</p>
      )}
      {canEdit ? (
        <form
          onSubmit={save}
          className="flex flex-wrap items-start gap-3"
          aria-label={`Set a secret: ${title}`}
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
      {footer}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
        title={`Delete ${removing ?? "the secret"}?`}
        description={removeText}
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
