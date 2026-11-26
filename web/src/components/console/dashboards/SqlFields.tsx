"use client";

import { Button } from "@ratel/design-system/button";
import { Field, Textarea } from "@ratel/design-system/input";
import { Play } from "lucide-react";
import { useState } from "react";
import { MAX_SQL_TEXT, type SqlQuery } from "@/lib/contracts/query";
import type { WidgetResult } from "@/lib/views/dashboards/types";
import { sqlWidgetQuery } from "@/lib/views/dashboards/widget";

/**
 * The RQL text of a widget of kind sql. The text runs when the person asks (Run, or ⌘Enter), not at
 * each key. A refusal of RQL shows its message and its fix under the editor.
 */
export function SqlFields({
  query,
  result,
  onChange,
  window = "The time range of the page is its window.",
}: {
  query: SqlQuery;
  /** What the query's window is, said under the editor. */
  window?: string;
  /** The last result read: a refusal is said under the editor. */
  result: WidgetResult | null;
  onChange: (next: SqlQuery) => void;
}) {
  const [draft, setDraft] = useState(query.text);
  const [ran, setRan] = useState(query.text);
  // Another text from outside (Edit as SQL, a starting point): the editor follows it.
  if (query.text !== ran) {
    setRan(query.text);
    setDraft(query.text);
  }
  const changed = draft.trim() !== query.text.trim();
  const run = () => {
    if (draft.trim()) onChange(sqlWidgetQuery(draft));
  };
  const refusal = result?.kind === "refused" && !changed ? result : null;

  return (
    <div className="flex flex-col gap-2">
      <Field
        label="RQL query"
        description={`RQL (Ratel Query Language): one SELECT over events, traces, scores, sessions and users. ${window}`}
        error={
          refusal ? (
            <>
              {refusal.message} <span className="text-fg-muted">Fix: {refusal.fix}</span>
            </>
          ) : undefined
        }
      >
        {(control) => (
          <Textarea
            {...control}
            value={draft}
            maxLength={MAX_SQL_TEXT}
            spellCheck={false}
            autoComplete="off"
            rows={Math.min(14, Math.max(5, draft.split("\n").length + 1))}
            className="font-mono text-xs"
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                run();
              }
            }}
          />
        )}
      </Field>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!changed || !draft.trim()} onClick={run}>
          <Play className="size-3.5" aria-hidden />
          Run
        </Button>
        <p className="text-xs text-fg-subtle">{changed ? "⌘Enter runs the query." : "Ran."}</p>
      </div>
    </div>
  );
}
