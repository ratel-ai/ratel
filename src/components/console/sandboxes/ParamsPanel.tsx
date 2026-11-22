"use client";

import { Button } from "@ratel/design-system/button";
import { Switch } from "@ratel/design-system/checkbox";
import { Field, Input } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import type { CallableProviderView, PlaygroundSandbox } from "@/lib/views/sandboxes/page";
import { modelOptions, type PlaygroundParam } from "@/lib/views/sandboxes/playground-state";
import { PromptEditor } from "./PromptEditor";

type ParamOf<K extends PlaygroundParam["kind"]> = Extract<PlaygroundParam, { kind: K }>;

export interface ParamsPanelProps {
  sandbox: PlaygroundSandbox;
  providers: readonly CallableProviderView[];
  /** The edited values; a param not in here is at its code default. */
  values: Readonly<Record<string, unknown>>;
  changed: readonly string[];
  errors: Readonly<Record<string, string>>;
  onChange: (name: string, value: unknown) => void;
  onReset: (name: string) => void;
  /** The Tools group, drawn between Prompts and Params. */
  tools?: ReactNode;
}

/**
 * The right panel (spec §9): Model, Prompts, Tools, Params and Context. Every
 * control starts at the code default; an edit applies to the next run, and
 * "Reset to code" puts the default back. A 400 from the run API shows under
 * the param it names.
 */
export function ParamsPanel({
  sandbox,
  providers,
  values,
  changed,
  errors,
  onChange,
  onReset,
  tools,
}: ParamsPanelProps) {
  const models = sandbox.params.filter((p): p is ParamOf<"model"> => p.kind === "model");
  const prompts = sandbox.params.filter((p): p is ParamOf<"prompt"> => p.kind === "prompt");
  const scalars = sandbox.params.filter((p): p is ParamOf<"scalar"> => p.kind === "scalar");
  const valueOf = (param: PlaygroundParam) =>
    param.name in values ? values[param.name] : param.default;
  const reset = (param: PlaygroundParam) =>
    changed.includes(param.name) ? (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onReset(param.name)}
        aria-label={`Reset ${param.name} to code`}
      >
        <RotateCcw className="size-3.5" aria-hidden />
        Reset to code
      </Button>
    ) : null;

  return (
    <div className="flex flex-col gap-6">
      {models.length > 0 ? (
        <PanelGroup title="Model">
          {models.map((param) => {
            const options = modelOptions(param, providers, sandbox.modelResolver);
            const current = String(valueOf(param));
            return (
              <ParamRow key={param.name} action={reset(param)}>
                <Field
                  label={<ParamLabel param={param} />}
                  error={errors[param.name]}
                  description={param.description}
                >
                  {(control) => (
                    <Select
                      id={control.id}
                      aria-label={param.name}
                      options={(options.includes(current) ? options : [current, ...options]).map(
                        (id) => ({ value: id, label: id }),
                      )}
                      value={current}
                      onValueChange={(next) => onChange(param.name, next)}
                      className="w-full font-mono text-xs"
                    />
                  )}
                </Field>
              </ParamRow>
            );
          })}
        </PanelGroup>
      ) : null}

      {prompts.length > 0 ? (
        <PanelGroup title="Prompts">
          {prompts.map((param) => (
            <ParamRow key={param.name} action={reset(param)}>
              <Field
                label={<ParamLabel param={param} />}
                error={errors[param.name]}
                description={
                  param.vars?.length ? `Vars: ${param.vars.join(", ")}` : param.description
                }
              >
                {(control) => (
                  <PromptEditor
                    id={control.id}
                    value={String(valueOf(param))}
                    onChange={(next) => onChange(param.name, next)}
                    invalid={control["aria-invalid"]}
                    describedBy={control["aria-describedby"]}
                  />
                )}
              </Field>
            </ParamRow>
          ))}
        </PanelGroup>
      ) : null}

      {tools}

      {scalars.length > 0 ? (
        <PanelGroup title="Params">
          {scalars.map((param) => (
            <ParamRow key={param.name} action={reset(param)}>
              <ScalarControl
                param={param}
                value={valueOf(param)}
                error={errors[param.name]}
                onChange={(next) => onChange(param.name, next)}
              />
            </ParamRow>
          ))}
        </PanelGroup>
      ) : null}

      {sandbox.context.length > 0 ? (
        <PanelGroup title="Context">
          <dl className="flex flex-col gap-1.5">
            {sandbox.context.map((entry) => (
              <div key={entry.name} className="flex items-baseline justify-between gap-3 text-ui">
                <dt className="font-mono text-xs text-fg-muted">{entry.name}</dt>
                <dd className="truncate font-mono text-xs text-fg-subtle">
                  {entry.default === undefined ? "none" : JSON.stringify(entry.default)}
                </dd>
              </div>
            ))}
          </dl>
        </PanelGroup>
      ) : null}
    </div>
  );
}

function ScalarControl({
  param,
  value,
  error,
  onChange,
}: {
  param: ParamOf<"scalar">;
  value: unknown;
  error?: string;
  onChange: (value: unknown) => void;
}) {
  const label = <ParamLabel param={param} />;
  if (param.type === "bool") {
    return (
      <div className="flex flex-col gap-1.5">
        <Switch
          label={<span className="font-mono text-xs">{param.name}</span>}
          checked={value === true}
          onCheckedChange={onChange}
        />
        {error ? <p className="text-xs text-danger">{error}</p> : null}
      </div>
    );
  }
  if (param.type === "enum") {
    return (
      <Field label={label} error={error} description={param.description}>
        {(control) => (
          <Select
            id={control.id}
            aria-label={param.name}
            options={param.values.map((v) => ({ value: v, label: v }))}
            value={String(value)}
            onValueChange={onChange}
            className="w-full"
          />
        )}
      </Field>
    );
  }
  if (param.type === "int" || param.type === "number") {
    const range = [
      param.min !== undefined ? `min ${param.min}` : null,
      param.max !== undefined ? `max ${param.max}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    return (
      <Field label={label} error={error} description={range || param.description}>
        {(control) => (
          <Input
            {...control}
            type="number"
            inputMode={param.type === "int" ? "numeric" : "decimal"}
            min={param.min}
            max={param.max}
            step={param.type === "int" ? 1 : "any"}
            value={
              typeof value === "number" && Number.isFinite(value) ? value : String(value ?? "")
            }
            onChange={(event) => {
              const raw = event.target.value;
              const parsed =
                param.type === "int" ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
              // Text that is not a number stays as typed, so the run API names the problem.
              onChange(raw.trim() === "" || Number.isNaN(parsed) ? raw : parsed);
            }}
            className="tabular-nums"
          />
        )}
      </Field>
    );
  }
  const maxLength = "maxLength" in param ? param.maxLength : undefined;
  return (
    <Field
      label={label}
      error={error}
      description={maxLength !== undefined ? `Up to ${maxLength} characters` : param.description}
    >
      {(control) => (
        <Input
          {...control}
          value={String(value ?? "")}
          maxLength={maxLength}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}

function PanelGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-fg">{title}</h2>
      {children}
    </section>
  );
}

function ParamLabel({ param }: { param: PlaygroundParam }) {
  return <span className="font-mono">{param.name}</span>;
}

/** A param's control with its "Reset to code" button outside the label, top right. */
function ParamRow({ action, children }: { action: ReactNode; children: ReactNode }) {
  return (
    <div className="relative">
      {action ? <div className="absolute -top-1.5 right-0">{action}</div> : null}
      {children}
    </div>
  );
}
