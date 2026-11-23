"use client";

import { Badge } from "@ratel/design-system/badge";
import { Checkbox } from "@ratel/design-system/checkbox";
import { cn } from "@ratel/design-system/cn";
import { Callout } from "@ratel/design-system/states";
import { apiKeyPolicy } from "@/lib/platform/api-keys/policy";
import {
  API_KEY_PRESET_INFO,
  API_KEY_PRESETS,
  API_KEY_SCOPE_INFO,
  API_KEY_SCOPES,
  type ApiKeyPreset,
  type ApiKeyScope,
  presetScopes,
  type ScopeGroup,
} from "@/lib/platform/api-keys/scopes";

export type ApiKeyAccessChoice = ApiKeyPreset | "custom";

const SCOPE_GROUPS: readonly ScopeGroup[] = ["Ingest", "Catalog", "Runtime", "Usage", "MCP"];

const CUSTOM_INFO = {
  label: "Custom",
  description: "Pick single permissions. Safe in an app only when every one sends data.",
};

/** Whether the chosen access makes a key that is safe to ship inside an app. */
export function choiceIsPublishable(
  choice: ApiKeyAccessChoice,
  scopes: readonly ApiKeyScope[],
): boolean {
  return apiKeyPolicy(choice === "custom" ? scopes : presetScopes(choice)).publishable;
}

/**
 * What a new key may do (RC-585): three presets, then single permissions for
 * anyone who needs exactly one surface. Each option says whether the key must
 * stay secret or is safe to put in an app, and the note under the picker says
 * it again for the current choice, so nobody ships a secret key by accident.
 */
export function ApiKeyAccessPicker({
  name,
  choice,
  scopes,
  disabled,
  onChoiceChange,
  onScopesChange,
}: {
  name: string;
  choice: ApiKeyAccessChoice;
  /** The single permissions picked, used when `choice` is custom. */
  scopes: readonly ApiKeyScope[];
  disabled?: boolean;
  onChoiceChange: (choice: ApiKeyAccessChoice) => void;
  onScopesChange: (scopes: ApiKeyScope[]) => void;
}) {
  const publishable = choiceIsPublishable(choice, scopes);
  const options: Array<{
    value: ApiKeyAccessChoice;
    label: string;
    description: string;
    publishable: boolean;
  }> = [
    ...API_KEY_PRESETS.map((preset) => ({
      value: preset,
      ...API_KEY_PRESET_INFO[preset],
      publishable: preset === "ingest",
    })),
    { value: "custom", ...CUSTOM_INFO, publishable: false },
  ];

  function toggle(scope: ApiKeyScope, on: boolean) {
    const next = on ? [...scopes, scope] : scopes.filter((existing) => existing !== scope);
    onScopesChange(API_KEY_SCOPES.filter((candidate) => next.includes(candidate)));
  }

  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
        <legend className="mb-1.5 text-ui font-medium text-fg">Access</legend>
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              "flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 transition-colors duration-120",
              choice === option.value
                ? "border-line-active bg-raised"
                : "border-line hover:bg-hover",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={choice === option.value}
              onChange={() => onChoiceChange(option.value)}
              className="mt-0.5 accent-accent-mark"
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2 text-ui font-medium text-fg">
                {option.label}
                {option.publishable ? <Badge tone="success">Safe in an app</Badge> : null}
              </span>
              <span className="text-xs text-fg-muted">{option.description}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {choice === "custom" ? (
        <div className="flex flex-col gap-3 rounded-md border border-line px-3 py-2.5">
          {SCOPE_GROUPS.map((group) => (
            <fieldset key={group} className="flex flex-col gap-1" disabled={disabled}>
              <legend className="mb-1 text-xs font-medium text-fg-subtle">{group}</legend>
              {API_KEY_SCOPES.filter((scope) => API_KEY_SCOPE_INFO[scope].group === group).map(
                (scope) => (
                  <Checkbox
                    key={scope}
                    name={`${name}-scope`}
                    checked={scopes.includes(scope)}
                    onCheckedChange={(on) => toggle(scope, on)}
                    disabled={disabled}
                    label={
                      <span className="flex flex-col">
                        <span>{API_KEY_SCOPE_INFO[scope].label}</span>
                        <span className="text-xs text-fg-subtle">
                          {API_KEY_SCOPE_INFO[scope].description}
                        </span>
                      </span>
                    }
                  />
                ),
              )}
            </fieldset>
          ))}
        </div>
      ) : null}

      {publishable ? (
        <Callout tone="success" title="Safe to put in an app">
          This key can only send telemetry to this project. If someone pulls it out of your app,
          they can add data here and nothing else. It starts with{" "}
          <code className="font-mono">rtl_pub_</code>.
        </Callout>
      ) : (
        <Callout tone="warning" title="Keep this key secret">
          Use it only on servers you control. Never put it in a desktop, mobile or browser app,
          where anyone can read it.
        </Callout>
      )}
    </div>
  );
}
