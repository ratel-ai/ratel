"use client";

import { Button } from "@ratel/design-system/button";
import { Field, Input, Textarea } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { Callout } from "@ratel/design-system/states";
import { type FormEvent, useState } from "react";
import type { z } from "zod";
import type { SkillFull } from "@/lib/catalog/agent-tools/outputs";
import { createSkillInput, editSkillInput } from "@/lib/catalog/manage";
import {
  buildCreatePayload,
  buildEditPayload,
  type CreateSkillBody,
  type EditSkillBody,
  hasEdits,
  type SkillFormValues,
  type SkillOriginal,
} from "@/lib/console/explore/forms";

/**
 * The create and edit form for a catalog skill, on the design system. It runs the same Zod schema
 * as the route (`createSkillInput`, `editSkillInput`) before it hands a payload up; the parent owns
 * the fetch, the refresh and the version conflict. The searchable description is edited in the
 * item detail, so this form has no field for it.
 */
function seed(skill?: SkillFull): SkillFormValues {
  return {
    name: skill?.name ?? "",
    description: skill?.description ?? "",
    searchableDescription: skill?.searchableDescription ?? "",
    useSearchableDescription: skill?.searchableDescription !== null && skill !== undefined,
    body: skill?.body ?? "",
    tags: skill ? skill.tags.join(", ") : "",
    tools: skill ? skill.tools.join(", ") : "",
    status: skill?.status === "published" ? "published" : "draft",
    model: skill?.model ?? "",
    endUser: skill?.endUserId ?? "",
  };
}

function zodFieldErrors(issues: z.ZodIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

/** A required field's label: the accent asterisk, as upstream; the control carries `aria-required`. */
function required(label: string) {
  return (
    <>
      {label}
      <span aria-hidden className="text-accent-mark">
        {" "}
        *
      </span>
    </>
  );
}

const STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "published", label: "Published" },
] as const;

export function SkillEditor({
  mode,
  skill,
  projectSlug,
  pending,
  notice,
  serverNameError,
  onCancel,
  onSubmitCreate,
  onSubmitEdit,
}: {
  mode: "create" | "edit";
  skill?: SkillFull;
  projectSlug: string;
  pending: boolean;
  /** Parent-set banner, such as the version-conflict reload notice. */
  notice?: string | null;
  /** Parent-set name error, such as a 409 name conflict from the route. */
  serverNameError?: string | null;
  /** Accepted for the upstream call site; the description is edited in the item detail. */
  searchableDescriptionEnabled?: boolean;
  catalogAdopted?: boolean | null;
  onCancel: () => void;
  onSubmitCreate: (body: CreateSkillBody) => void;
  onSubmitEdit: (body: EditSkillBody) => void;
}) {
  const [values, setValues] = useState<SkillFormValues>(() => seed(skill));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const original: SkillOriginal | null = skill
    ? {
        name: skill.name,
        description: skill.description,
        searchableDescription: skill.searchableDescription,
        body: skill.body,
        tags: skill.tags,
        tools: skill.tools,
        endUserId: skill.endUserId,
      }
    : null;
  const editBody =
    mode === "edit" && original && skill ? buildEditPayload(values, original, skill.version) : null;
  const canSave = mode === "create" || (editBody !== null && hasEdits(editBody));

  function set<K extends keyof SkillFormValues>(key: K, value: SkillFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors(({ [key]: _, ...rest }) => rest);
    setFormError(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrors({});
    setFormError(null);
    if (mode === "create") {
      const payload = buildCreatePayload(values, projectSlug);
      const parsed = createSkillInput.safeParse(payload);
      if (!parsed.success) return setErrors(zodFieldErrors(parsed.error.issues));
      onSubmitCreate(payload);
      return;
    }
    if (!editBody || !hasEdits(editBody)) return setFormError("No changes to save.");
    const parsed = editSkillInput.safeParse(editBody);
    if (!parsed.success) return setErrors(zodFieldErrors(parsed.error.issues));
    onSubmitEdit(editBody);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Skill">
      {notice ? <Callout tone="warning">{notice}</Callout> : null}

      <Field
        label={required("Name")}
        description="kebab-case: lowercase letters, digits, single hyphens"
        error={errors.name ?? serverNameError ?? null}
      >
        {(control) => (
          <Input
            {...control}
            value={values.name}
            onChange={(event) => set("name", event.currentTarget.value)}
            placeholder="make-changelog"
            aria-required
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        )}
      </Field>

      <Field label={required("Description")} error={errors.description ?? null}>
        {(control) => (
          <Textarea
            {...control}
            value={values.description}
            onChange={(event) => set("description", event.currentTarget.value)}
            rows={2}
            placeholder="What this skill does and when to use it."
            aria-required
          />
        )}
      </Field>

      <Field label={required("Body (SKILL.md)")} error={errors.body ?? null}>
        {(control) => (
          <Textarea
            {...control}
            value={values.body}
            onChange={(event) => set("body", event.currentTarget.value)}
            rows={12}
            placeholder="# The skill's instructions…"
            aria-required
            spellCheck={false}
            className="font-mono text-xs"
          />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Tags" description="Comma-separated" error={errors.tags ?? null}>
          {(control) => (
            <Input
              {...control}
              value={values.tags}
              onChange={(event) => set("tags", event.currentTarget.value)}
              placeholder="git, docs"
            />
          )}
        </Field>
        <Field label="Tools" description="Comma-separated" error={errors.tools ?? null}>
          {(control) => (
            <Input
              {...control}
              value={values.tools}
              onChange={(event) => set("tools", event.currentTarget.value)}
              placeholder="read_file, write_file"
            />
          )}
        </Field>
      </div>

      <Field
        label="End user (scope)"
        description="Optional. Scope this skill to one end-user id; empty means every user. The SDK sync does not serve scoped skills yet."
        error={errors.endUserId ?? null}
      >
        {(control) => (
          <Input
            {...control}
            value={values.endUser}
            onChange={(event) => set("endUser", event.currentTarget.value)}
            placeholder="u-ada"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        )}
      </Field>

      {/* Status and model are set on create only: the edit route accepts neither. */}
      {mode === "create" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Status">
            {(control) => (
              <Select
                id={control.id}
                options={STATUS_OPTIONS}
                value={values.status}
                onValueChange={(value) => set("status", value as SkillFormValues["status"])}
              />
            )}
          </Field>
          <Field
            label="Model"
            description="Optional, attribution only"
            error={errors.model ?? null}
          >
            {(control) => (
              <Input
                {...control}
                value={values.model}
                onChange={(event) => set("model", event.currentTarget.value)}
                placeholder="claude-sonnet-5"
                spellCheck={false}
                className="font-mono"
              />
            )}
          </Field>
        </div>
      ) : null}

      {formError ? <p className="text-xs text-danger">{formError}</p> : null}

      <div className="mt-1 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" loading={pending} disabled={!canSave}>
          {pending ? "Saving…" : mode === "create" ? "Create skill" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
