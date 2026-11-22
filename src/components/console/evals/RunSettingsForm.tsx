"use client";

import { Button } from "@ratel/design-system/button";
import { Field, Input } from "@ratel/design-system/input";
import { Section } from "@ratel/design-system/section";
import { Select } from "@ratel/design-system/select";
import { toast } from "@ratel/design-system/toast";
import { useState, useTransition } from "react";
import { saveRunSettingsAction } from "@/lib/views/evals/actions";
import { RUN_SETTING_LABELS, type RunSettings } from "@/lib/views/evals/domain/run-settings";
import type { RunSettingsModel } from "@/lib/views/evals/run-settings";

const INHERIT = "inherit";
const MODEL_KEYS = ["agentModel", "toolModel", "judgeModel"] as const;
const NUMBER_KEYS = [
  { key: "temperature", step: "0.1", hint: "0 to 1. Only 4.x agent models take one." },
  { key: "maxTokens", step: "1", hint: "Per agent answer." },
  { key: "maxSteps", step: "1", hint: "Agent steps per run." },
  { key: "budgetUsd", step: "0.01", hint: "USD per run." },
] as const;

/** The run settings as the form edits them: a model id or `inherit`, a number as text or "" (use the level under it). */
export type RunSettingsDraft = Record<
  (typeof MODEL_KEYS)[number] | (typeof NUMBER_KEYS)[number]["key"],
  string
>;

/**
 * RC-653: the models and limits of the suite's runs, with its own save. RC-657:
 * the eval's run settings are fields of the eval editor (`RunSettingsFields`)
 * and save with it (UX audit RC-656, P9).
 */
export function RunSettingsForm({
  projectId,
  model,
}: {
  projectId: string;
  model: RunSettingsModel;
}) {
  const [draft, setDraft] = useState<RunSettingsDraft>(() => runSettingsDraft(model.own));
  const [saved, setSaved] = useState<RunSettingsDraft>(() => runSettingsDraft(model.own));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);

  function save() {
    setError(null);
    start(async () => {
      const result = await saveRunSettingsAction(projectId, null, settingsOfDraft(draft));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const next = runSettingsDraft(result.value);
      setDraft(next);
      setSaved(next);
      toast({ title: "Suite run settings saved." });
    });
  }

  return (
    <Section
      title="Suite run settings"
      description="The default models and limits of every eval. An eval can set its own."
      actions={
        <Button variant="secondary" size="sm" disabled={!changed || pending} onClick={save}>
          {pending ? "Saving…" : "Save run settings"}
        </Button>
      }
    >
      <RunSettingsFields model={model} draft={draft} onChange={setDraft} disabled={pending} />
      {error ? (
        <p role="alert" className="pt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </Section>
  );
}

/**
 * The run settings fields. A setting left to the level under it shows that
 * value in words ("Suite default: 4096"), not an empty field (UX audit P4).
 * "Set own" turns it into a field; "Use suite default" clears it again.
 */
export function RunSettingsFields({
  model,
  draft,
  onChange,
  disabled = false,
  narrow = false,
}: {
  model: RunSettingsModel;
  draft: RunSettingsDraft;
  onChange: (draft: RunSettingsDraft) => void;
  disabled?: boolean;
  /** Two columns at most: the editor's column is too narrow for four. */
  narrow?: boolean;
}) {
  const fallback = fallbackLabel(model);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const set = (key: keyof RunSettingsDraft, value: string) => onChange({ ...draft, [key]: value });
  const open = (key: string, on: boolean) =>
    setOpened((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  return (
    <div className="flex flex-col gap-2">
      <div
        className={
          narrow
            ? "grid grid-cols-1 gap-4 sm:grid-cols-2"
            : "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
        }
        data-run-settings={model.level}
      >
        {MODEL_KEYS.map((key) => (
          <Field key={key} label={RUN_SETTING_LABELS[key]}>
            {(control) => (
              <Select
                {...control}
                aria-label={RUN_SETTING_LABELS[key]}
                value={draft[key]}
                onValueChange={(value) => set(key, value)}
                options={[
                  { value: INHERIT, label: `${fallback}: ${inheritedModel(model, key)}` },
                  ...model.models.map((id) => ({ value: id, label: id })),
                ]}
                disabled={disabled}
                className="w-full"
              />
            )}
          </Field>
        ))}
        {NUMBER_KEYS.map(({ key, step, hint }) => {
          const inherited = model.inherited[key];
          const own = draft[key] !== "" || opened.has(key);
          return (
            <Field key={key} label={RUN_SETTING_LABELS[key]} description={hint}>
              {(control) =>
                own ? (
                  <span className="flex items-center gap-1">
                    <Input
                      {...control}
                      type="number"
                      inputMode="decimal"
                      step={step}
                      min={0}
                      name={key}
                      value={draft[key]}
                      onChange={(event) => set(key, event.target.value)}
                      disabled={disabled}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      onClick={() => {
                        open(key, false);
                        set(key, "");
                      }}
                    >
                      Use default
                    </Button>
                  </span>
                ) : (
                  <span
                    className="flex h-8 items-center justify-between gap-2 rounded-md border border-dashed border-line px-2.5 text-ui"
                    data-default-setting={key}
                  >
                    <span className="truncate text-fg-muted">
                      {fallback}:{" "}
                      <span className="font-mono text-fg">{inherited ?? "model default"}</span>
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      aria-label={`Set own ${RUN_SETTING_LABELS[key].toLowerCase()}`}
                      onClick={() => {
                        open(key, true);
                        set(key, inherited === null ? "" : String(inherited));
                      }}
                    >
                      Set own
                    </Button>
                  </span>
                )
              }
            </Field>
          );
        })}
      </div>
      {model.notEnabled.length > 0 ? (
        <p className="text-xs text-fg-subtle" data-not-enabled>
          Not enabled on Bedrock (model_not_enabled), so not offered:{" "}
          <span className="font-mono">{model.notEnabled.join(", ")}</span>
        </p>
      ) : null}
    </div>
  );
}

/** The collapsed row of the run settings: each model with its value and source, then the limits. */
export function runSettingsHint(model: RunSettingsModel, draft: RunSettingsDraft): string {
  const fallback = fallbackLabel(model).toLowerCase();
  const models = MODEL_KEYS.map((key) =>
    draft[key] === INHERIT
      ? `${RUN_SETTING_LABELS[key]}: ${inheritedModel(model, key)} (${fallback})`
      : `${RUN_SETTING_LABELS[key]}: ${draft[key]}`,
  );
  const own = NUMBER_KEYS.filter(({ key }) => draft[key].trim() !== "").length;
  return [
    ...models,
    own === 0 ? `Limits: ${fallback}` : `${own} own ${own === 1 ? "limit" : "limits"}`,
  ].join(" · ");
}

export function runSettingsDraft(settings: RunSettings): RunSettingsDraft {
  const model = (value: string | undefined) => value ?? INHERIT;
  const number = (value: number | undefined) => (value === undefined ? "" : String(value));
  return {
    agentModel: model(settings.agentModel),
    toolModel: model(settings.toolModel),
    judgeModel: model(settings.judgeModel),
    temperature: number(settings.temperature),
    maxTokens: number(settings.maxTokens),
    maxSteps: number(settings.maxSteps),
    budgetUsd: number(settings.budgetUsd),
  };
}

/** The draft as settings: an empty field is left out, so it uses the level under it. A number field that is not a number is sent as is, and the server refuses it. */
export function settingsOfDraft(draft: RunSettingsDraft): RunSettings {
  const out: Record<string, string | number> = {};
  for (const key of MODEL_KEYS) if (draft[key] !== INHERIT) out[key] = draft[key];
  for (const { key } of NUMBER_KEYS) {
    const raw = draft[key].trim();
    if (raw !== "") out[key] = Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  return out as RunSettings;
}

function fallbackLabel(model: RunSettingsModel): string {
  return model.level === "eval" ? "Suite default" : "Default";
}

function inheritedModel(model: RunSettingsModel, key: (typeof MODEL_KEYS)[number]): string {
  return key === "agentModel"
    ? (model.inherited.agentModel ?? "recorded model")
    : model.inherited[key];
}
