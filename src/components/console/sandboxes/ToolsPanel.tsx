"use client";

import { Button } from "@ratel/design-system/button";
import { Switch } from "@ratel/design-system/checkbox";
import { Field, Textarea } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { RotateCcw, TriangleAlert } from "lucide-react";
import {
  allowedToolModes,
  defaultToolMode,
  type ManifestTool,
  type ToolMode,
  type ToolSetting,
} from "@/lib/views/sandboxes/tools-state";

export interface ToolsPanelProps {
  tools: readonly ManifestTool[];
  settings: Readonly<Record<string, ToolSetting>>;
  onChange: (tool: string, setting: ToolSetting) => void;
}

const MODE_LABEL: Record<ToolMode, string> = {
  real: "Real",
  fake: "Fake",
  confirm: "Confirm",
};

/**
 * The Tools group of the right panel (spec §3.6, §9): per tool, on or off,
 * its description with "Reset to code", and its mode. The panel offers only
 * the modes the sandbox file allows. Edits apply to the next run.
 */
export function ToolsPanel({ tools, settings, onChange }: ToolsPanelProps) {
  if (tools.length === 0) return null;
  return (
    <section className="flex flex-col gap-3" aria-label="Tools">
      <h2 className="text-sm font-semibold text-fg">Tools</h2>
      <ul className="flex flex-col divide-y divide-line">
        {tools.map((tool) => (
          <li key={tool.name} className="py-3 first:pt-0 last:pb-0">
            <ToolRow
              tool={tool}
              setting={settings[tool.name] ?? {}}
              onChange={(next) => onChange(tool.name, next)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ToolRow({
  tool,
  setting,
  onChange,
}: {
  tool: ManifestTool;
  setting: ToolSetting;
  onChange: (setting: ToolSetting) => void;
}) {
  const enabled = setting.enabled !== false;
  const description = setting.description ?? tool.description;
  const descriptionChanged = description !== tool.description;
  const fallback = defaultToolMode(tool);
  const modes = allowedToolModes(tool);
  const mode = setting.mode && modes.includes(setting.mode) ? setting.mode : fallback;
  const realBlocked = tool.hint === "sideEffect" && !modes.includes("real");

  return (
    <div className="flex flex-col gap-2.5">
      <Switch
        label={
          <code translate="no" className="font-mono text-xs">
            {tool.name}
          </code>
        }
        checked={enabled}
        onCheckedChange={(on) => onChange({ ...setting, enabled: on })}
      />
      {enabled ? (
        <>
          <Field
            label="Mode"
            description={realBlocked ? "Real needs allowReal in the sandbox file." : undefined}
          >
            {(control) => (
              <Select
                id={control.id}
                aria-label={`Mode of ${tool.name}`}
                options={modes.map((m) => ({
                  value: m,
                  label: m === fallback ? `${MODE_LABEL[m]} (default)` : MODE_LABEL[m],
                }))}
                value={mode}
                onValueChange={(next) => onChange({ ...setting, mode: next as ToolMode })}
                className="w-full"
              />
            )}
          </Field>
          {tool.opaque ? (
            <p className="flex items-start gap-1.5 text-xs text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Opaque: the mode applies to the whole call, including its sub-calls.
            </p>
          ) : null}
          <div className="relative">
            {descriptionChanged ? (
              <div className="absolute -top-1.5 right-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onChange({ ...setting, description: undefined })}
                  aria-label={`Reset the description of ${tool.name} to code`}
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                  Reset to code
                </Button>
              </div>
            ) : null}
            <Field label="Description">
              {(control) => (
                <Textarea
                  {...control}
                  value={description}
                  onChange={(event) => onChange({ ...setting, description: event.target.value })}
                  className="min-h-16 text-xs"
                />
              )}
            </Field>
          </div>
        </>
      ) : (
        <p className="text-xs text-fg-subtle">
          Off for the next run: the model does not see this tool.
        </p>
      )}
    </div>
  );
}
