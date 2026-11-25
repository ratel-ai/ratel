"use client";

import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { Field, Input } from "@ratel/design-system/input";
import { Section } from "@ratel/design-system/section";
import { Select } from "@ratel/design-system/select";
import { Callout } from "@ratel/design-system/states";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { toast } from "@ratel/design-system/toast";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { changeAlertAction } from "@/app/(console)/project/[projectId]/alerts/actions";
import { type MetricQuery, metricQuery, parseQuery } from "@/lib/contracts/query";
import { getMetric } from "@/lib/synthesis/metrics/catalog";
import type { TraceFilterBarFacets } from "@/lib/synthesis/traces/v2/filters";
import {
  alertWindowText,
  thresholdFrom,
  thresholdInput,
  thresholdUnit,
  WINDOW_LABELS,
} from "@/lib/views/alerts/format";
import { alertHref, alertsHref } from "@/lib/views/alerts/links";
import {
  ALERT_WINDOWS,
  type AlertDraft,
  type AlertOperator,
  type AlertRule,
  type AlertWindow,
  MAX_ALERT_NAME,
} from "@/lib/views/alerts/types";
import type { ScorerOption } from "@/lib/views/dashboards/types";
import { changeQuery, type QueryChange, queryName } from "@/lib/views/dashboards/widget";
import { Choice, MetricFields, MetricFilter } from "../dashboards/MetricFields";
import { AlertPreviewChart } from "./AlertPreviewChart";

const DEFAULT_QUERY = metricQuery("error_rate", "rate");
const OPERATORS: readonly { value: AlertOperator; label: string }[] = [
  { value: "above", label: "Above" },
  { value: "below", label: "Below" },
];

/** Create or edit an alert on one page: what is measured, the condition, its name. */
export function AlertForm({
  projectId,
  rule,
  start,
  scorers,
  facets,
}: {
  projectId: string;
  /** Null: a new one. */
  rule: AlertRule | null;
  /** What a new one measures at first. */
  start: MetricQuery | null;
  scorers: readonly ScorerOption[] | null;
  facets: TraceFilterBarFacets;
}) {
  const router = useRouter();
  const [query, setQuery] = useState<MetricQuery>(() => startQuery(rule?.query ?? start));
  const [name, setName] = useState(rule?.name ?? "");
  const [operator, setOperator] = useState<AlertOperator>(rule?.operator ?? "above");
  const unit = getMetric(query.measures[0].measure)?.unit ?? "count";
  const [thresholdText, setThresholdText] = useState(
    // A threshold without its query has no unit.
    rule?.query ? thresholdInput(rule.threshold, unit) : "",
  );
  const [windowMinutes, setWindowMinutes] = useState<AlertWindow>(rule?.windowMinutes ?? 15);
  const [thresholdMissing, setThresholdMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const threshold = thresholdFrom(thresholdText, unit);
  const defaultName = queryName(query);

  function edit(change: QueryChange) {
    const next = changeQuery(query, change, scorers ?? []);
    // A threshold in another unit is another threshold.
    if (getMetric(next.measures[0].measure)?.unit !== unit) setThresholdText("");
    setQuery(next);
  }

  function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (threshold === null) {
      setThresholdMissing(true);
      return;
    }
    const draft: AlertDraft = {
      name: name.trim() || defaultName,
      query,
      operator,
      threshold,
      windowMinutes,
    };
    startSave(async () => {
      const result = await changeAlertAction(
        rule
          ? { projectId, action: "update", ruleId: rule.id, draft }
          : { projectId, action: "create", draft },
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast({ title: rule ? "Alert saved" : "Alert created", tone: "success" });
      if (rule) router.refresh();
      else router.push(alertHref(projectId, result.ruleId));
    });
  }

  return (
    <form noValidate onSubmit={save} className="flex max-w-3xl flex-col gap-8">
      <Section title="1. Metric">
        <div className="flex flex-col gap-4">
          <MetricFields query={query} scorers={scorers} onChange={edit} />
          <MetricFilter
            query={query}
            facets={facets}
            onChange={(next) =>
              setQuery((current) =>
                changeQuery(current, { filter: next(current.filters) }, scorers ?? []),
              )
            }
          />
        </div>
      </Section>

      <Section title="2. Condition">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
            <Choice label="Alert when the value is">
              <SegmentedControl
                label="Operator"
                options={OPERATORS}
                value={operator}
                onValueChange={setOperator}
              />
            </Choice>
            <Field
              label={thresholdUnit(unit) ? `Threshold (${thresholdUnit(unit)})` : "Threshold"}
              error={
                thresholdMissing && threshold === null ? "Enter a number of 0 or more." : undefined
              }
              className="w-44"
            >
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="any"
                  value={thresholdText}
                  onChange={(event) => setThresholdText(event.currentTarget.value)}
                />
              )}
            </Field>
            <Field label="Over the last" className="w-40">
              {({ id }) => (
                <Select
                  id={id}
                  className="w-full"
                  options={ALERT_WINDOWS.map((minutes) => ({
                    value: String(minutes),
                    label: WINDOW_LABELS[minutes],
                  }))}
                  value={String(windowMinutes)}
                  onValueChange={(value) => setWindowMinutes(Number(value) as AlertWindow)}
                />
              )}
            </Field>
          </div>
          <p className="text-xs text-fg-subtle">{alertWindowText(query.measures[0].aggregation)}</p>
          <AlertPreviewChart
            projectId={projectId}
            query={query}
            windowMinutes={windowMinutes}
            threshold={threshold}
          />
        </div>
      </Section>

      <Section title="3. Name">
        <div className="flex flex-col gap-4">
          <Callout tone="warning" title="This alert notifies nobody">
            Its state and history are recorded.
          </Callout>
          <Field label="Name">
            {(control) => (
              <Input
                {...control}
                value={name}
                maxLength={MAX_ALERT_NAME}
                autoComplete="off"
                placeholder={defaultName}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            )}
          </Field>
        </div>
      </Section>

      {error ? (
        <Callout tone="danger" title="The alert was not saved">
          {error}
        </Callout>
      ) : null}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" loading={saving}>
          {rule ? "Save alert" : "Create alert"}
        </Button>
        <Link href={alertsHref(projectId)} className={buttonVariants({ variant: "ghost" })}>
          Cancel
        </Link>
      </div>
    </form>
  );
}

/** A query the contract no longer allows cannot be edited: the form starts again. */
function startQuery(query: MetricQuery | null): MetricQuery {
  return query && parseQuery(query).ok ? query : DEFAULT_QUERY;
}
