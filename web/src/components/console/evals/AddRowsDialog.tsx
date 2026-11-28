"use client";

import { Button } from "@ratel/design-system/button";
import { Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Field, Input, Textarea } from "@ratel/design-system/input";
import { Callout } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Choice } from "./Choice";
import { evalsApi, send } from "./request";
import { TracePicker } from "./TracePicker";

type Mode = "traces" | "values";

/**
 * "Add rows" of a fixed dataset: trace turns that you choose (each a frozen copy of its input and
 * tool fixtures), or one row of typed values. A row counts in the next run at once.
 */
export function AddRowsDialog({
  projectId,
  datasetId,
  tasks,
}: {
  projectId: string;
  datasetId: string;
  tasks: ReadonlyArray<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("traces");
  const [turnIds, setTurnIds] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [values, setValues] = useState('{\n  "message": ""\n}');
  const [expected, setExpected] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function rows(): unknown[] | string {
    if (mode === "traces") {
      return turnIds.length === 0
        ? "Choose at least one trace."
        : turnIds.map((turnId) => ({ kind: "turn", turnId }));
    }
    if (name.trim() === "") return "Give the row a name.";
    let parsed: unknown;
    try {
      parsed = JSON.parse(values);
    } catch {
      return "The values must be a JSON object.";
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return "The values must be a JSON object, one field for each value.";
    }
    return [
      {
        kind: "values",
        name: name.trim(),
        values: parsed,
        expectedOutput: expected.trim() === "" ? null : expected,
      },
    ];
  }

  async function add() {
    const made = rows();
    if (typeof made === "string") return setProblem(made);
    setPending(true);
    setProblem(null);
    const answer = await send<{ rows: unknown[] }>(
      "POST",
      `${evalsApi(projectId)}/datasets/${datasetId}/rows`,
      { rows: made },
    );
    setPending(false);
    if (!answer.ok) return setProblem(answer.message);
    const count = answer.data.rows.length;
    toast({
      title: `${count} ${count === 1 ? "row" : "rows"} added. They count in the next run.`,
      tone: "success",
    });
    setOpen(false);
    setTurnIds([]);
    setName("");
    setExpected("");
    router.refresh();
  }

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        Add rows
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Add rows"
          description="A row counts in the next run of each eval that uses this dataset."
          className="w-[min(36rem,calc(100vw-2rem))]"
          footer={
            <>
              <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
              <Button variant="primary" onClick={add} loading={pending}>
                Add rows
              </Button>
            </>
          }
        >
          {problem ? <Callout tone="danger">{problem}</Callout> : null}
          <Choice
            legend="From"
            name="row-source"
            value={mode}
            onChange={setMode}
            options={[
              {
                value: "traces",
                label: "Traces",
                description: "Each chosen trace becomes a row with its input.",
              },
              {
                value: "values",
                label: "Typed values",
                description: "One row with named values and an expected answer.",
              },
            ]}
          />
          {mode === "traces" ? (
            <TracePicker
              projectId={projectId}
              tasks={tasks}
              chosen={turnIds}
              onChange={setTurnIds}
            />
          ) : (
            <>
              <Field label="Name">
                {(control) => (
                  <Input
                    {...control}
                    value={name}
                    maxLength={200}
                    onChange={(e) => setName(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Values (JSON object)" description="They are the input of the row.">
                {(control) => (
                  <Textarea
                    {...control}
                    rows={5}
                    spellCheck={false}
                    className="font-mono text-xs"
                    value={values}
                    onChange={(e) => setValues(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Expected output (optional)">
                {(control) => (
                  <Textarea
                    {...control}
                    rows={2}
                    value={expected}
                    onChange={(e) => setExpected(e.target.value)}
                  />
                )}
              </Field>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
