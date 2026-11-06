"use client";

import { Button } from "@ratel/design-system/button";
import { Dialog, DialogContent } from "@ratel/design-system/dialog";
import { Field, Input, Textarea } from "@ratel/design-system/input";
import { toast } from "@ratel/design-system/toast";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import {
  changeTaskEvalAction,
  draftTaskTestAction,
} from "@/app/(console)/project/[projectId]/tasks/[taskId]/eval-actions";
import type { TestProposal } from "@/lib/views/task-evals/test-proposal";

const LIMITS = [
  ["maxToolCalls", "Max tool calls", "1"],
  ["maxSelfCorrections", "Max self-corrections", "1"],
  ["maxLatencyMs", "Max run time (ms)", "any"],
  ["maxCostUsd", "Max cost (USD)", "any"],
] as const;

export function RunToTest({
  projectId,
  taskId,
  turnId,
  inEvalSet = false,
}: {
  projectId: string;
  taskId: string;
  turnId: string;
  inEvalSet?: boolean;
}) {
  const router = useRouter();
  const [proposal, setProposal] = useState<TestProposal | null>(null);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const request = useRef(0);

  function draft() {
    const current = ++request.current;
    setProposal(null);
    setError(null);
    setOpen(true);
    startTransition(async () => {
      const result = await draftTaskTestAction({ projectId, taskId, turnId });
      if (current !== request.current) return;
      if (result.ok) setProposal(result.proposal);
      else setError(result.error);
    });
  }

  function save(form: FormData) {
    if (!proposal) return;
    const edited: TestProposal = {
      name: String(form.get("name") ?? ""),
      ask: String(form.get("ask") ?? ""),
      criteria: String(form.get("criteria") ?? ""),
      expected: { ...proposal.expected, tool: String(form.get("tool") ?? "").trim() || null },
    };
    for (const [key] of LIMITS) {
      const value = String(form.get(key) ?? "").trim();
      edited.expected[key] = value ? Number(value) : null;
    }
    setError(null);
    startTransition(async () => {
      const result = await changeTaskEvalAction({
        projectId,
        taskId,
        action: "add",
        runId: turnId,
        proposal: edited,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      setOpen(false);
      toast({ title: "Test added to the eval set", tone: "success" });
      router.refresh();
    });
  }

  if (inEvalSet || saved) return <span className="text-xs text-fg-subtle">In the eval set</span>;
  return (
    <>
      <Button size="sm" variant="secondary" onClick={draft} disabled={pending}>
        Turn into a test
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && pending && proposal) return;
          if (!next && !proposal) request.current++;
          setOpen(next);
        }}
      >
        <DialogContent
          title="Turn into a test"
          description="Review the proposal before you add it to this task's eval set."
          className="w-[min(40rem,calc(100vw-2rem))]"
        >
          {!proposal ? (
            <div aria-live="polite" className="text-sm text-fg-muted">
              {error ?? "Drafting a test…"}
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                save(new FormData(event.currentTarget));
              }}
              className="flex flex-col gap-4"
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter")
                  event.currentTarget.requestSubmit();
              }}
            >
              <Field label="Test name">
                {(control) => (
                  <Input
                    {...control}
                    name="name"
                    defaultValue={proposal.name}
                    required
                    maxLength={200}
                    autoComplete="off"
                  />
                )}
              </Field>
              <Field label="Ask">
                {(control) => (
                  <Textarea
                    {...control}
                    name="ask"
                    defaultValue={proposal.ask}
                    required
                    maxLength={10000}
                  />
                )}
              </Field>
              <fieldset className="grid grid-cols-2 gap-3">
                <legend className="mb-2 text-xs text-fg-muted">
                  Expected values (leave blank to skip)
                </legend>
                <Field label="Expected tool" className="col-span-2">
                  {(control) => (
                    <Input
                      {...control}
                      name="tool"
                      defaultValue={proposal.expected.tool ?? ""}
                      maxLength={500}
                      autoComplete="off"
                    />
                  )}
                </Field>
                {LIMITS.map(([key, label, step]) => (
                  <Field key={key} label={label}>
                    {(control) => (
                      <Input
                        {...control}
                        type="number"
                        name={key}
                        min={0}
                        step={step}
                        defaultValue={proposal.expected[key] ?? ""}
                      />
                    )}
                  </Field>
                ))}
              </fieldset>
              <Field label="Acceptance criteria">
                {(control) => (
                  <Textarea
                    {...control}
                    name="criteria"
                    defaultValue={proposal.criteria}
                    required
                    maxLength={5000}
                  />
                )}
              </Field>
              {error ? (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button type="button" onClick={() => setOpen(false)} disabled={pending}>
                  Cancel
                </Button>
                <Button variant="primary" type="submit" loading={pending}>
                  Save
                </Button>
              </div>
            </form>
          )}
          {!proposal ? (
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  request.current++;
                  setOpen(false);
                }}
              >
                Cancel
              </Button>
              {error ? (
                <Button onClick={draft} disabled={pending}>
                  Retry
                </Button>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
