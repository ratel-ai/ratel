"use client";

import { Badge } from "@ratel/design-system/badge";
import { Section } from "@ratel/design-system/section";
import { Select } from "@ratel/design-system/select";
import { EmptyState } from "@ratel/design-system/states";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Sparkline } from "@/components/console/health/primitives/Sparkline";
import { editScorerAction } from "@/lib/views/scorers/actions";
import { SCORER_KINDS, type ScorerKind, type ScorerScope } from "@/lib/views/scorers/domain/types";
import {
  KIND_LABELS,
  type ScorerRow,
  suiteScorerHref,
  taskScorerHref,
} from "@/lib/views/scorers/view";

/**
 * RC-615: scorers as a list. Each row opens the scorer's detail page, the
 * only place it is edited. "Add scorer" makes one from a starter for the
 * chosen kind and opens it.
 */
export function ScorerList({
  projectId,
  scope,
  taskId = null,
  rows,
  title = "Scorers",
  description,
}: {
  projectId: string;
  scope: ScorerScope;
  taskId?: string | null;
  rows: readonly ScorerRow[];
  title?: string;
  description?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function add(kind: string) {
    if (!SCORER_KINDS.includes(kind as ScorerKind)) return;
    setError(null);
    startTransition(async () => {
      const result = await editScorerAction(projectId, {
        action: "create",
        scope,
        taskId,
        kind: kind as ScorerKind,
      });
      if (!result.ok || !result.value)
        return setError(result.ok ? "Could not add the scorer." : result.error);
      router.push(
        scope === "task" && taskId
          ? taskScorerHref(projectId, taskId, result.value.id)
          : suiteScorerHref(projectId, result.value.id),
      );
    });
  }

  return (
    <Section
      title={title}
      description={description}
      actions={
        <Select
          aria-label="Add scorer"
          placeholder="Add scorer"
          value=""
          disabled={pending}
          options={SCORER_KINDS.map((kind) => ({ value: kind, label: KIND_LABELS[kind] }))}
          onValueChange={add}
        />
      }
    >
      {error ? (
        <p role="alert" className="pb-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          title="No scorers yet"
          description="Add a scorer to say what a good run is. Pick its kind in Add scorer."
        />
      ) : (
        <ul className="divide-y divide-line border-y border-line" aria-label={title}>
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-4 py-2.5">
              <Link
                href={row.href}
                className="min-w-0 flex-1 truncate text-sm font-medium text-fg hover:underline"
              >
                {row.name}
              </Link>
              <Badge tone={row.builtIn ? "neutral" : "info"}>{row.kind}</Badge>
              <span className={row.enabled ? "w-7 text-ui text-fg" : "w-7 text-ui text-fg-subtle"}>
                {row.enabled ? "On" : "Off"}
              </span>
              <span
                className="w-14 text-right text-ui tabular-nums text-fg-muted"
                title="Pass rate, last 14 days"
              >
                {row.passRate === null ? "–" : `${Math.round(row.passRate * 100)}%`}
              </span>
              <Sparkline data={row.trend} color="var(--ds-chart-1)" width={88} height={22} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
