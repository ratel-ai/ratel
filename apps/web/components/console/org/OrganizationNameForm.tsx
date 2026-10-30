"use client";

import { Button } from "@ratel/design-system/button";
import { Field, Input } from "@ratel/design-system/input";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState, useTransition } from "react";
import { updateOrganizationAction } from "@/app/(console)/org/[orgSlug]/settings/actions";
import { organizationRoot } from "@/lib/console/navigation";
import { ORG_NAME_MAX_LEN, ORG_SLUG_MAX_LEN } from "@/lib/platform/organization";

/**
 * The organization's name and its address, edited together (admins only). A new address moves
 * this page to it.
 */
export function OrganizationNameForm({
  currentName,
  currentSlug,
}: {
  currentName: string;
  currentSlug: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(currentName);
  const [slug, setSlug] = useState(currentSlug);
  const [saved, setSaved] = useState({ name: currentName, slug: currentSlug });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const nameRef = useRef<HTMLInputElement>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const nextName = name.trim();
    const nextSlug = slug.trim();
    if (!nextName) {
      setError("Enter a name for the organization.");
      nameRef.current?.focus();
      return;
    }
    if (nextName === saved.name && nextSlug === saved.slug) return;
    setError(null);
    startTransition(async () => {
      const result = await updateOrganizationAction(saved.slug, nextName, nextSlug);
      if (!result.ok) {
        setError(result.error);
        nameRef.current?.focus();
        return;
      }
      setName(result.name);
      setSlug(result.slug);
      setSaved({ name: result.name, slug: result.slug });
      toast({ title: "Organization updated", tone: "success" });
      if (result.slug !== saved.slug) router.replace(`${organizationRoot(result.slug)}/settings`);
    });
  }

  return (
    <form
      onSubmit={submit}
      className="flex max-w-md flex-col items-start gap-4"
      aria-label="Organization"
    >
      <Field
        label="Name"
        className="w-full"
        error={error}
        description="Everyone in the organization sees it."
      >
        {(control) => (
          <Input
            {...control}
            ref={nameRef}
            name="name"
            value={name}
            maxLength={ORG_NAME_MAX_LEN}
            placeholder="Acme Inc."
            autoComplete="organization"
            onChange={(event) => {
              setName(event.currentTarget.value);
              setError(null);
            }}
          />
        )}
      </Field>
      <Field
        label="Address"
        className="w-full"
        description="Links to this organization's pages use it."
      >
        {(control) => (
          <div className="flex h-8 w-full items-center rounded-md border border-line-strong bg-app focus-within:border-line-active focus-within:ring-2 focus-within:ring-focus/40">
            <span aria-hidden className="pl-2.5 font-mono text-xs text-fg-subtle">
              /org/
            </span>
            <input
              {...control}
              name="slug"
              value={slug}
              maxLength={ORG_SLUG_MAX_LEN}
              autoComplete="off"
              spellCheck={false}
              className="h-full min-w-0 flex-1 bg-transparent pr-2.5 pl-0.5 font-mono text-xs text-fg outline-none max-md:text-base"
              onChange={(event) => {
                setSlug(event.currentTarget.value);
                setError(null);
              }}
            />
          </div>
        )}
      </Field>
      <Button type="submit" loading={pending}>
        {pending ? "Saving…" : "Save changes"}
      </Button>
    </form>
  );
}
