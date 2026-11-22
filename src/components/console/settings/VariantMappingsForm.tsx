"use client";

import { Button, IconButton } from "@ratel/design-system/button";
import { Field, Input } from "@ratel/design-system/input";
import { toast } from "@ratel/design-system/toast";
import { Trash2 } from "lucide-react";
import { type FormEvent, useState, useTransition } from "react";
import {
  removeVariantMappingAction,
  saveVariantMappingAction,
} from "@/app/(console)/project/[projectId]/settings/variant-actions";

export interface VariantMappingRow {
  id: string;
  attributeKey: string;
  experiment: string;
}

const MAX_FIELD_LENGTH = 256;

/**
 * The list of a project's variant attribute mappings, a remove button on each,
 * and a form to add one (DESIGN.md, Forms): labels above, Enter saves, the
 * error under the form, the result as a toast.
 */
export function VariantMappingsForm({
  projectId,
  mappings,
  canAdd,
}: {
  projectId: string;
  mappings: VariantMappingRow[];
  canAdd: boolean;
}) {
  const [attributeKey, setAttributeKey] = useState("");
  const [experiment, setExperiment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (!attributeKey.trim() || !experiment.trim()) {
      setError("Enter an attribute key and an experiment.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await saveVariantMappingAction(projectId, attributeKey, experiment);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setAttributeKey("");
      setExperiment("");
      toast({
        title: "Variant attribute saved",
        description: "New spans with this attribute get a variant.",
        tone: "success",
      });
    });
  }

  function remove(mapping: VariantMappingRow) {
    startTransition(async () => {
      const result = await removeVariantMappingAction(projectId, mapping.id);
      if (!result.ok) {
        toast({ title: "Couldn't remove it", description: result.message, tone: "danger" });
        return;
      }
      toast({
        title: "Variant attribute removed",
        description: `New spans with ${mapping.attributeKey} get no variant.`,
        tone: "success",
      });
    });
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      {mappings.length > 0 ? (
        <ul
          className="flex flex-col divide-y divide-line rounded-md border border-line"
          aria-label="Variant attributes"
        >
          {mappings.map((mapping) => (
            <li key={mapping.id} className="flex items-center gap-3 px-3 py-2 text-ui">
              <code className="min-w-0 truncate font-mono text-fg">{mapping.attributeKey}</code>
              <span className="text-fg-muted">variant of</span>
              <code className="min-w-0 flex-1 truncate font-mono text-fg">
                {mapping.experiment}
              </code>
              <IconButton
                label={`Remove ${mapping.attributeKey}`}
                icon={<Trash2 />}
                size="icon-sm"
                disabled={pending}
                onClick={() => remove(mapping)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ui text-fg-muted">No variant attributes yet.</p>
      )}
      {canAdd ? (
        <form
          onSubmit={add}
          className="flex flex-col items-start gap-3"
          aria-label="Add a variant attribute"
        >
          <div className="grid w-full gap-3 sm:grid-cols-2">
            <Field label="Attribute key" error={error}>
              {(control) => (
                <Input
                  {...control}
                  name="attributeKey"
                  placeholder="app.variant"
                  value={attributeKey}
                  maxLength={MAX_FIELD_LENGTH}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setAttributeKey(event.currentTarget.value);
                    setError(null);
                  }}
                />
              )}
            </Field>
            <Field label="Experiment">
              {(control) => (
                <Input
                  {...control}
                  name="experiment"
                  placeholder="checkout-model"
                  value={experiment}
                  maxLength={MAX_FIELD_LENGTH}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setExperiment(event.currentTarget.value);
                    setError(null);
                  }}
                />
              )}
            </Field>
          </div>
          <Button type="submit" variant="primary" disabled={pending}>
            Add
          </Button>
        </form>
      ) : (
        <p className="text-ui text-fg-muted">
          This project has the most variant attributes. Remove one to add another.
        </p>
      )}
    </div>
  );
}
