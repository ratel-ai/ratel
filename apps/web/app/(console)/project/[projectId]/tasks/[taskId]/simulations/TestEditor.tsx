"use client";

import { Button } from "@ratel/design-system/button";
import { DialogContent } from "@ratel/design-system/dialog";
import { Field, Input, Textarea } from "@ratel/design-system/input";
import { type FormEvent, useState } from "react";
import type { TaskSimulationDetail } from "@/lib/views/task-evals/simulation-page";
import { type SimulationScope, useSimulationAction } from "./SimulationControls";

export function TestEditor({
  scope,
  row,
  onDone,
}: {
  scope: SimulationScope;
  row?: TaskSimulationDetail["fixCases"][number];
  onDone(): void;
}) {
  const [runId, setRunId] = useState("");
  const [tool, setTool] = useState(row?.expected.tool ?? "");
  const [calls, setCalls] = useState(row?.expected.maxToolCalls?.toString() ?? "");
  const [criteria, setCriteria] = useState(row?.criteria ?? "");
  const { busy, submit } = useSimulationAction(scope);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const expected: Record<string, unknown> = Object.fromEntries(
      Object.entries(row?.expected ?? {}).filter(([, value]) => value !== null),
    );
    delete expected.tool;
    delete expected.maxToolCalls;
    if (tool.trim()) expected.tool = tool.trim();
    if (calls.trim()) expected.maxToolCalls = Number(calls);
    if (
      await submit({
        action: row ? "edit-test" : "add-test",
        ...(row ? { caseId: row.id } : { runId }),
        expected,
        criteria,
      })
    )
      onDone();
  };
  return (
    <DialogContent
      title={row ? "Edit test" : "Add a test"}
      description="This test runs only for this fix on this task."
    >
      <form onSubmit={save} className="flex flex-col gap-4">
        {!row ? (
          <Field label="Run or trace ID">
            {(control) => (
              <Input
                {...control}
                required
                value={runId}
                onChange={(event) => setRunId(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </Field>
        ) : (
          <p className="text-ui text-fg-muted">{row.ask}</p>
        )}
        <Field label="Expected tool" description="Optional. Use the tool's catalog ID.">
          {(control) => (
            <Input {...control} value={tool} onChange={(event) => setTool(event.target.value)} />
          )}
        </Field>
        <Field
          label="Maximum tool calls"
          description="Optional. Leave empty to use the task's scorer."
        >
          {(control) => (
            <Input
              {...control}
              type="number"
              min={0}
              step={1}
              value={calls}
              onChange={(event) => setCalls(event.target.value)}
            />
          )}
        </Field>
        <Field
          label="Criteria"
          description="Optional. Describe what a successful reply must contain."
        >
          {(control) => (
            <Textarea
              {...control}
              value={criteria}
              maxLength={10000}
              onChange={(event) => setCriteria(event.target.value)}
            />
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onDone}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {row ? "Save test" : "Add test"}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
