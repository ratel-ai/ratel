"use client";

import { Button } from "@ratel/design-system/button";
import { Field, Input } from "@ratel/design-system/input";
import { toast } from "@ratel/design-system/toast";
import { type FormEvent, useRef, useState, useTransition } from "react";
import { updateProjectNameAction } from "@/app/(console)/project/[projectId]/settings/actions";
import { PROJECT_NAME_MAX_LEN } from "@/lib/platform/projects/names";

/**
 * The project's name, edited in place (DESIGN.md, Forms): the label above, Enter saves, the error
 * under the field takes focus, and the result is a toast. Renaming is an admin action; members
 * see the name read-only.
 */
export function ProjectNameForm({
  currentName,
  projectId,
  canRename,
}: {
  currentName: string;
  projectId: string;
  canRename: boolean;
}) {
  const [value, setValue] = useState(currentName);
  const [savedName, setSavedName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !canRename) return;
    const name = value.trim();
    if (!name) {
      setError("Enter a name for the project.");
      inputRef.current?.focus();
      return;
    }
    if (name === savedName) return;
    setError(null);
    startTransition(async () => {
      const result = await updateProjectNameAction(projectId, name);
      if (!result.ok) {
        setError(result.error);
        inputRef.current?.focus();
        return;
      }
      setValue(result.name);
      setSavedName(result.name);
      toast({
        title: "Project renamed",
        description: `It reads ${result.name} everywhere now.`,
        tone: "success",
      });
    });
  }

  return (
    <form
      onSubmit={submit}
      className="flex max-w-md flex-col items-start gap-3"
      aria-label="Project name"
    >
      <Field
        label="Name"
        className="w-full"
        error={error}
        description={
          canRename
            ? "Shown in the sidebar, the project switcher and page titles."
            : "Only organization admins can rename a project."
        }
      >
        {(control) => (
          <Input
            {...control}
            ref={inputRef}
            name="name"
            value={value}
            maxLength={PROJECT_NAME_MAX_LEN}
            autoComplete="off"
            spellCheck={false}
            readOnly={!canRename}
            onChange={(event) => {
              setValue(event.currentTarget.value);
              setError(null);
            }}
          />
        )}
      </Field>
      {canRename ? (
        <Button type="submit" loading={pending}>
          {pending ? "Saving…" : "Save name"}
        </Button>
      ) : null}
    </form>
  );
}
