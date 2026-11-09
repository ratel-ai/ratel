"use client";

import { Button } from "@ratel/design-system/button";
import { Disclosure } from "@ratel/design-system/disclosure";
import { Field, Input, Textarea } from "@ratel/design-system/input";
import { type FormEvent, useState } from "react";
import type { FixChange } from "@/lib/views/eval-gate/types";
import {
  RunTaskSimulationButton,
  type SimulationScope,
  useSimulationAction,
} from "./SimulationControls";

export function DraftEditor({
  scope,
  change,
  tools,
  running,
}: {
  scope: SimulationScope;
  change: FixChange;
  tools: { id: string; label: string }[];
  running: boolean;
}) {
  const [draft, setDraft] = useState(change);
  const [dirty, setDirty] = useState(false);
  const [advanced, setAdvanced] = useState(JSON.stringify(change, null, 2));
  const [error, setError] = useState("");
  const { busy, submit } = useSimulationAction(scope);
  const names = new Map(tools.map((tool) => [tool.id, tool.label]));
  const patch = (next: FixChange) => {
    setDraft(next);
    setAdvanced(JSON.stringify(next, null, 2));
    setDirty(true);
    setError("");
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!error && (await submit({ action: "draft", change: JSON.parse(advanced) })))
      setDirty(false);
  };
  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      {Object.entries(draft.patches).map(([id, text]) => (
        <Field key={id} label={`${names.get(id) ?? id} description`}>
          {(control) => (
            <Textarea
              {...control}
              value={text}
              onChange={(event) =>
                patch({ ...draft, patches: { ...draft.patches, [id]: event.target.value } })
              }
              className="min-h-32"
            />
          )}
        </Field>
      ))}
      {draft.add.map((tool, index) => (
        <Field key={tool.id} label={`${tool.name} description`}>
          {(control) => (
            <Textarea
              {...control}
              value={tool.searchable}
              onChange={(event) =>
                patch({
                  ...draft,
                  add: draft.add.map((item, i) =>
                    i === index ? { ...item, searchable: event.target.value } : item,
                  ),
                })
              }
            />
          )}
        </Field>
      ))}
      {draft.topK !== null ? (
        <Field label="Results per search">
          {(control) => (
            <Input
              {...control}
              type="number"
              min={1}
              step={1}
              value={draft.topK ?? ""}
              onChange={(event) => patch({ ...draft, topK: Number(event.target.value) })}
              className="max-w-40"
            />
          )}
        </Field>
      ) : null}
      {(
        [
          ["hide", "Tools to remove"],
          ["collapse", "Tools to combine"],
          ["dedupeRetries", "Tools with fewer retries"],
          ["skillSteps", "Skill steps"],
        ] as const
      )
        .filter(([key]) => change[key].length > 0)
        .map(([key, label]) => (
          <ToolListField
            key={key}
            label={label}
            value={draft[key]}
            onChange={(value) => patch({ ...draft, [key]: value })}
          />
        ))}
      {draft.replay?.tools.map((tool, index) => (
        <Field key={tool.name} label={`${tool.name} tool description`}>
          {(control) => (
            <Textarea
              {...control}
              value={tool.description}
              onChange={(event) =>
                patch({
                  ...draft,
                  replay: {
                    ...draft.replay!,
                    tools: draft.replay!.tools.map((item, i) =>
                      i === index ? { ...item, description: event.target.value } : item,
                    ),
                  },
                })
              }
            />
          )}
        </Field>
      ))}
      <Disclosure title="Change details" hint="All editable fields">
        <Field
          label="Change JSON"
          error={error || undefined}
          description="Edit tool definitions, removed tools, or the steps this fix changes."
        >
          {(control) => (
            <Textarea
              {...control}
              className="min-h-64 font-mono text-xs"
              value={advanced}
              spellCheck={false}
              onChange={(event) => {
                setAdvanced(event.target.value);
                setDirty(true);
                try {
                  const value: unknown = JSON.parse(event.target.value);
                  if (!value || typeof value !== "object" || Array.isArray(value)) {
                    setError("Enter a change object.");
                    return;
                  }
                  // Keep the structured controls stable until a valid change is saved.
                  setError("");
                } catch {
                  setError("Enter valid JSON.");
                }
              }}
            />
          )}
        </Field>
        <Button
          className="mt-3"
          disabled={!!error}
          loading={busy}
          onClick={async () => {
            if (await submit({ action: "draft", change: JSON.parse(advanced) })) setDirty(false);
          }}
        >
          Save change details
        </Button>
      </Disclosure>
      {change.unsupportedReason ? (
        <p className="text-ui text-fg-muted">{change.unsupportedReason}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={busy} disabled={!dirty || !!error}>
          Save draft
        </Button>
        <RunTaskSimulationButton scope={scope} running={running} disabled={dirty || busy} />
        {dirty ? (
          <span className="text-xs text-fg-subtle">Save the draft before you run it.</span>
        ) : null}
      </div>
    </form>
  );
}

function ToolListField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[];
  onChange(value: string[]): void;
}) {
  const [text, setText] = useState(value.join(", "));
  return (
    <Field label={label} description="Separate tool IDs with commas.">
      {(control) => (
        <Input
          {...control}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            onChange(
              event.target.value
                .split(",")
                .map((id) => id.trim())
                .filter(Boolean),
            );
          }}
        />
      )}
    </Field>
  );
}
