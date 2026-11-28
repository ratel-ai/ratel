"use client";

import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Skeleton } from "@ratel/design-system/states";
import { useEffect, useId, useRef, useState } from "react";
import {
  askSuggestionsAction,
  draftWidgetsAction,
  setAskOutcomeAction,
} from "@/app/(console)/project/[projectId]/dashboards/ask-actions";
import { CardFrame } from "@/components/console/grid/CardFrame";
import { RANGE_PRESETS } from "@/lib/synthesis/dashboard";
import type { TraceFilterBarFacets } from "@/lib/synthesis/traces/v2/filters";
import { askOutcome, isChoice } from "@/lib/views/ask/outcome";
import { hasUnsavedChanges } from "@/lib/views/dashboards/expanded";
import { filtersProblem } from "@/lib/views/dashboards/filters";
import { cardHeightPx, defaultSize } from "@/lib/views/dashboards/layout";
import type { DashboardRange } from "@/lib/views/dashboards/links";
import type { DashboardFilters, WidgetInput, WidgetResult } from "@/lib/views/dashboards/types";
import { widgetName } from "@/lib/views/dashboards/widget";
import { AskField } from "./AskField";
import { useWidgetPreview } from "./use-widget-preview";
import { WidgetCardBody } from "./WidgetCardBody";
import { WidgetFields } from "./WidgetFields";

/**
 * A new widget, in a small modal dialog over the dashboard (decisions `widget-create-dialog` and
 * `widget-dialog-layout`). One column: the ask field, the configuration, then the widget. The
 * widget is absent until an ask or the first change of the query or the chart; then it is the
 * card the dashboard will draw, with the same frame, body and height. The draft of an ask fills the
 * fields, and every field stays editable. The page behind changes only at Save. The ask's outcome is stored as the dialog
 * ends: kept, edited or discarded (`lib/views/ask/outcome.ts`).
 */
export function NewWidgetDialog({
  open,
  onOpenChange,
  ...form
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & FormProps) {
  // Escape, a click outside, Cancel and Close ask first when an edit or a draft would be lost.
  const [leaving, setLeaving] = useState(false);
  const dirty = useRef(false);
  const close = () => {
    setLeaving(false);
    onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || !dirty.current) close();
        else setLeaving(true);
      }}
    >
      {open ? (
        <NewWidgetForm
          {...form}
          dirty={dirty}
          leaving={leaving}
          onStay={() => setLeaving(false)}
          onClose={close}
        />
      ) : null}
    </Dialog>
  );
}

interface FormProps {
  projectId: string;
  dashboardId: string;
  /** What the widget starts from: a blank one, or a scorer's. */
  start: WidgetInput;
  /** The start is a choice already (a scorer's widget): the chart shows at once. */
  startChosen: boolean;
  /** This deployment can draft: without it the ask field is hidden. */
  ask: boolean;
  facets: TraceFilterBarFacets;
  range: DashboardRange;
  filters: DashboardFilters;
  saving: boolean;
  /** Adds the widget; true when it was saved. */
  onSave: (widget: WidgetInput) => Promise<boolean>;
}

/** Inside the popup, so every open starts again. */
function NewWidgetForm({
  projectId,
  dashboardId,
  start,
  startChosen,
  ask,
  facets,
  range,
  filters,
  saving,
  onSave,
  dirty,
  leaving,
  onStay,
  onClose,
}: FormProps & {
  /** Set by the form: whether closing now loses an edit or a draft. */
  dirty: { current: boolean };
  /** The person asked to close with an edit or a draft in the dialog. */
  leaving: boolean;
  onStay: () => void;
  onClose: () => void;
}) {
  const formId = useId();
  const [widget, setWidget] = useState(start);
  const [chosen, setChosen] = useState(startChosen);
  const [refused, setRefused] = useState<string | null>(null);
  const [result, setResult] = useState<WidgetResult | null>(null);
  const [asks, setAsks] = useState(ask);
  const [words, setWords] = useState("");
  const [prompts, setPrompts] = useState<string[]>([]);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The ask whose draft is in the fields, until its outcome is stored.
  const draft = useRef<{ askId: string; widget: WidgetInput } | null>(null);
  // Whether the dialog is open, and whether a save is under way: a draft settles once.
  const alive = useRef(true);
  const savingNow = useRef(false);
  dirty.current = draft.current !== null || hasUnsavedChanges(start, widget);

  useEffect(() => {
    if (!ask) return;
    let stale = false;
    askSuggestionsAction(projectId, { target: "widget", dashboardId })
      .then(({ prompts }) => {
        if (!stale) setPrompts(prompts);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [ask, projectId, dashboardId]);

  // A dialog that closes with a draft in it discards the draft, unless a save stores its outcome.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (draft.current && !savingNow.current)
        void settle(projectId, draft.current.askId, "discarded");
    };
  }, [projectId]);

  async function askForDraft() {
    setAsking(true);
    setProblem(null);
    setNote(null);
    try {
      const result = await draftWidgetsAction(projectId, {
        target: "widget",
        dashboardId,
        words,
        range: { from: range.from, to: range.to },
      });
      // The dialog closed while the draft came back: nobody saw it.
      if (!alive.current) {
        if (result.status === "drafted") void settle(projectId, result.askId, "discarded");
        return;
      }
      if (result.status === "not_set_up") {
        setAsks(false);
        return;
      }
      if (result.status !== "drafted") {
        setProblem(result.message);
        return;
      }
      const [first] = result.widgets;
      if (!first) {
        // A refused draft keeps nothing the person could edit.
        void settle(projectId, result.askId, "discarded");
        setProblem(
          result.refused[0]
            ? `The draft was refused: ${result.refused[0].reason}`
            : "The draft has no widget. Say it in other words, or fill the fields.",
        );
        return;
      }
      // Another ask replaces the draft in the fields.
      if (draft.current) void settle(projectId, draft.current.askId, "discarded");
      const filled: WidgetInput = { title: first.title, query: first.query, chart: first.chart };
      draft.current = { askId: result.askId, widget: filled };
      setWidget(filled);
      setChosen(true);
      setNote(
        [
          "Drafted from your words. Change anything before you add it.",
          rangeNote(result.range, range.preset),
        ]
          .filter(Boolean)
          .join(" "),
      );
    } catch {
      setProblem("Could not ask for a draft. Try again.");
    } finally {
      setAsking(false);
    }
  }

  async function submit() {
    savingNow.current = true;
    const saved = await onSave(widget).catch(() => false);
    savingNow.current = false;
    if (!saved) return;
    const asked = draft.current;
    draft.current = null;
    if (asked) void settle(projectId, asked.askId, askOutcome([asked.widget], [widget]));
    onClose();
  }

  return (
    <DialogContent
      title="New widget"
      className="top-[4vh] max-h-[92dvh] w-[min(40rem,calc(100vw-2rem))]"
      footer={
        leaving ? (
          <>
            <p role="alert" className="mr-auto self-center text-sm text-fg">
              Close without adding? Your changes to this widget are lost.
            </p>
            <Button variant="secondary" onClick={onStay}>
              Keep editing
            </Button>
            <Button variant="danger" onClick={onClose}>
              Discard widget
            </Button>
          </>
        ) : (
          <>
            <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
            <Button type="submit" form={formId} variant="primary" loading={saving}>
              Add widget
            </Button>
          </>
        )
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {asks ? (
          <AskField
            label="What should this widget show?"
            placeholder="For example: the slowest tools this week"
            words={words}
            onWords={setWords}
            prompts={prompts}
            asking={asking}
            onAsk={() => void askForDraft()}
            note={note}
            problem={problem}
          />
        ) : null}
        <fieldset aria-label="Properties" className="flex min-w-0 flex-col gap-4">
          <WidgetFields
            widget={widget}
            onChange={(next) => {
              const changed = next(widget);
              const blocked = filtersProblem([changed.query], filters);
              setRefused(blocked);
              if (blocked) return;
              if (isChoice(widget, changed)) setChosen(true);
              setWidget(changed);
            }}
            refused={refused ? { field: "filter", message: refused } : null}
            facets={facets}
            range={range}
            result={result}
          />
        </fieldset>
        {chosen ? (
          <WidgetPreview
            projectId={projectId}
            widget={widget}
            range={range}
            filters={filters}
            onResult={setResult}
          />
        ) : null}
      </form>
    </DialogContent>
  );
}

/** The widget as a dashboard card, as it changes: mounted only after the first choice, so nothing reads before. */
function WidgetPreview({
  projectId,
  widget,
  range,
  filters,
  onResult,
}: {
  projectId: string;
  widget: WidgetInput;
  range: DashboardRange;
  filters: DashboardFilters;
  /** The last result read, for the names the fields offer. */
  onResult: (result: WidgetResult | null) => void;
}) {
  const { preview, pending } = useWidgetPreview(projectId, widget, range, filters);
  const read = preview?.ok ? preview.result : null;
  useEffect(() => onResult(read), [read, onResult]);
  return (
    // The card as the dashboard draws it: the same frame and body, at the height of a new widget.
    <div
      aria-busy={pending || undefined}
      style={{ height: cardHeightPx(defaultSize(widget.chart).h) }}
      className={cn(
        "@container min-w-0 transition-opacity duration-160",
        pending && preview && "opacity-60",
      )}
    >
      <CardFrame id="new-widget" title={widgetName(widget)} titleRow={null} edit={null}>
        {preview ? (
          preview.ok ? (
            <WidgetCardBody
              projectId={projectId}
              // The read has no title (a title changes no number): the chart is named as the card.
              widget={{ ...preview.widget, title: widget.title }}
              result={preview.result}
              range={range}
              filters={filters}
            />
          ) : (
            <p role="status" className="text-sm text-danger">
              {preview.error}
            </p>
          )
        ) : (
          <Skeleton className="h-full w-full" />
        )}
      </CardFrame>
    </div>
  );
}

/** Said when the words name a range other than the dashboard's: the widget reads the dashboard's. */
function rangeNote(named: string | null, shown: string): string | null {
  if (!named || named === shown) return null;
  const label = (id: string) => RANGE_PRESETS.find((preset) => preset.id === id)?.label;
  const page = label(shown);
  return `Your words name ${label(named)?.toLowerCase()}. The widget reads the range of the dashboard${page ? `: ${page.toLowerCase()}` : ""}.`;
}

function settle(projectId: string, askId: string, outcome: "kept" | "edited" | "discarded") {
  return setAskOutcomeAction(projectId, askId, outcome).catch(() => ({ ok: false }));
}
