"use client";

import { Button } from "@ratel/design-system/button";
import { Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Field, Input } from "@ratel/design-system/input";
import { useEffect, useId, useState } from "react";
import {
  askSuggestionsAction,
  buildDashboardAction,
} from "@/app/(console)/project/[projectId]/dashboards/ask-actions";
import { MAX_DASHBOARD_NAME } from "@/lib/views/dashboards/types";
import { AskField } from "./AskField";

/**
 * Create a dashboard: a title, and what it should show (decision `ask-no-confirm`). `Create blank`
 * makes it empty, as before. `Build dashboard` drafts the widgets and makes the dashboard of the
 * good ones at once, then opens it: no step asks to confirm them. The dashboard names the widgets
 * that were left out. Without a model key the words field is hidden and the dialog makes a blank
 * dashboard.
 */

export function CreateDashboardDialog({
  open,
  onOpenChange,
  ...form
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & FormProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <CreateForm {...form} /> : null}
    </Dialog>
  );
}

interface FormProps {
  projectId: string;
  /** This deployment can draft: without it the words field is hidden. */
  ask: boolean;
  /** A blank dashboard is being made. */
  saving: boolean;
  /** Makes a blank dashboard and opens it. */
  onCreateBlank: (name: string) => void;
  /** Opens the dashboard a build made, with the ask that made it. */
  onBuilt: (dashboardId: string, askId: string) => void;
}

function CreateForm({ projectId, ask, saving, onCreateBlank, onBuilt }: FormProps) {
  const formId = useId();
  const [title, setTitle] = useState("");
  const [words, setWords] = useState("");
  const [asks, setAsks] = useState(ask);
  const [prompts, setPrompts] = useState<string[]>([]);
  const [building, setBuilding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!ask) return;
    let stale = false;
    askSuggestionsAction(projectId, { target: "dashboard", dashboardId: null })
      .then(({ prompts }) => {
        if (!stale) setPrompts(prompts);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [ask, projectId]);

  const named = title.trim().length > 0;
  const busy = building || saving;

  async function build() {
    if (!named || !words.trim() || busy) return;
    setBuilding(true);
    setProblem(null);
    try {
      const result = await buildDashboardAction(projectId, { title, words });
      if (result.ok) {
        // The dialog stays busy while the new dashboard opens: no second build.
        onBuilt(result.dashboardId, result.askId);
        return;
      }
      if (result.notSetUp) setAsks(false);
      setProblem(result.message);
    } catch {
      setProblem("Could not build the dashboard. Try again.");
    }
    setBuilding(false);
  }

  function blank() {
    if (named && !busy) onCreateBlank(title);
  }

  return (
    <DialogContent
      title="Create dashboard"
      footer={
        <>
          <DialogClose render={<Button variant="secondary" />} disabled={building}>
            Cancel
          </DialogClose>
          <Button
            variant={asks ? "secondary" : "primary"}
            loading={saving}
            disabled={!named || building}
            onClick={blank}
          >
            Create blank
          </Button>
          {asks ? (
            <Button
              type="submit"
              form={formId}
              variant="primary"
              loading={building}
              disabled={!named || !words.trim() || saving}
            >
              {building ? "Building dashboard" : "Build dashboard"}
            </Button>
          ) : null}
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        aria-busy={building || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          if (asks) void build();
          else blank();
        }}
      >
        <Field label="Title">
          {(control) => (
            <Input
              {...control}
              value={title}
              required
              maxLength={MAX_DASHBOARD_NAME}
              autoComplete="off"
              placeholder="Support agent"
              disabled={building}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
          )}
        </Field>
        {asks ? (
          <AskField
            label="What should this dashboard show?"
            placeholder="Say what you want to watch, for example: how often my agent fails and what it costs per day"
            words={words}
            onWords={setWords}
            prompts={building ? [] : prompts}
            note={
              building
                ? "Drafting the widgets and checking their RQL. The dashboard opens when it is ready."
                : null
            }
            problem={problem}
          />
        ) : problem ? (
          <p role="status" className="text-xs text-fg-subtle">
            {problem}
          </p>
        ) : null}
      </form>
    </DialogContent>
  );
}
