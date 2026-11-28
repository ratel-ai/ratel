"use client";

import { Switch } from "@ratel/design-system/checkbox";
import { Field, Input } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import type { ParamSpec } from "@/lib/views/sandboxes/run-form";

/** One control for a declared param: a switch, a select, a number or a text field. */
export function ParamControl({
  param,
  value,
  error,
  onChange,
}: {
  param: ParamSpec;
  value: string | boolean;
  error: string | null;
  onChange: (value: string | boolean) => void;
}) {
  const hint = [
    param.description,
    param.default === null ? null : `Default: ${String(param.default)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  if (param.type === "boolean") {
    return (
      <div className="flex flex-col gap-1">
        <Switch
          label={<code className="font-mono text-ui">{param.name}</code>}
          checked={value === true}
          onCheckedChange={onChange}
        />
        {hint ? <p className="text-xs text-fg-subtle">{hint}</p> : null}
      </div>
    );
  }
  const label = <code className="font-mono">{param.name}</code>;
  return (
    <Field label={label} description={hint || undefined} error={error}>
      {(control) =>
        param.type === "enum" ? (
          <Select
            id={control.id}
            aria-label={param.name}
            value={String(value)}
            onValueChange={onChange}
            options={param.options.map((option) => ({
              value: String(option),
              label: String(option),
            }))}
            className="w-full"
          />
        ) : (
          <Input
            {...control}
            type={param.type === "number" ? "number" : "text"}
            inputMode={param.type === "number" ? "decimal" : undefined}
            step="any"
            value={String(value)}
            placeholder={param.default === null ? "" : String(param.default)}
            onChange={(event) => onChange(event.target.value)}
          />
        )
      }
    </Field>
  );
}
