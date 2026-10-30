"use client";

import { Button } from "@ratel/design-system/button";
import { Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Field, Input } from "@ratel/design-system/input";
import { Plus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useRef, useState, useTransition } from "react";
import { createProjectAction } from "@/app/(console)/org/[orgSlug]/actions";
import { PROJECT_NAME_MAX_LEN } from "@/lib/platform/projects/names";

/** The URL flag that opens the dialog, so the switcher and ⌘K can link to it. */
export const NEW_PROJECT_PARAM = "new";

/**
 * "New project": a name, then the project opens. At the plan's cap the button stays visible but
 * off, and the page says why.
 */
export function NewProjectDialog({
  organizationSlug,
  atCap,
}: {
  organizationSlug: string;
  atCap: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const open = !atCap && params.get(NEW_PROJECT_PARAM) === "1";
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function setOpen(next: boolean) {
    const query = new URLSearchParams(params.toString());
    if (next) query.set(NEW_PROJECT_PARAM, "1");
    else query.delete(NEW_PROJECT_PARAM);
    const text = query.toString();
    router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false });
    if (!next) {
      setName("");
      setError(null);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (!name.trim()) {
      setError("Enter a name for the project.");
      inputRef.current?.focus();
      return;
    }
    setError(null);
    startTransition(async () => {
      // Success redirects to the new project; only a refusal comes back.
      const result = await createProjectAction(organizationSlug, name);
      setError(result.error);
      inputRef.current?.focus();
    });
  }

  return (
    <>
      <Button variant="primary" disabled={atCap} onClick={() => setOpen(true)}>
        <Plus aria-hidden />
        New project
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="New project"
          description="A project holds one agent's traces, logs and catalog."
        >
          <form onSubmit={submit} className="flex flex-col gap-4" aria-label="New project">
            <Field label="Name" error={error}>
              {(control) => (
                <Input
                  {...control}
                  ref={inputRef}
                  name="name"
                  value={name}
                  maxLength={PROJECT_NAME_MAX_LEN}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Support agent"
                  onChange={(event) => {
                    setName(event.currentTarget.value);
                    setError(null);
                  }}
                />
              )}
            </Field>
            <div className="flex justify-end gap-2">
              <DialogClose render={<Button variant="secondary" type="button" />}>
                Cancel
              </DialogClose>
              <Button type="submit" variant="primary" loading={pending}>
                {pending ? "Creating…" : "Create project"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
