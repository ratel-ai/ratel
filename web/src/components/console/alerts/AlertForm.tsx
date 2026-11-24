"use client";

import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { Checkbox } from "@ratel/design-system/checkbox";
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
import { projectSettingsRoot } from "@/lib/console/settings/tabs";
import { getMetric } from "@/lib/synthesis/metrics/catalog";
import type { TraceFilterBarFacets } from "@/lib/synthesis/traces/v2/filters";
import {
  metricText,
  thresholdFrom,
  thresholdInput,
  thresholdUnit,
  WINDOW_LABELS,
} from "@/lib/views/alerts/format";
import { alertHref, alertsHref } from "@/lib/views/alerts/links";
import {
  ALERT_WINDOWS,
  type AlertDestination,
  type AlertDraft,
  type AlertOperator,
  type AlertQuery,
  type AlertRule,
  type AlertWindow,
  MAX_ALERT_NAME,
} from "@/lib/views/alerts/types";
import type { ScorerOption, WidgetInput } from "@/lib/views/dashboards/types";
import { Choice, changedWidget, MetricFields, MetricFilter } from "../dashboards/MetricFields";
import { AlertPreviewChart } from "./AlertPreviewChart";

const DEFAULT_QUERY: AlertQuery = { metric: "error_rate", aggregation: "rate", filter: {} };
const OPERATORS: readonly { value: AlertOperator; label: string }[] = [
  { value: "above", label: "Above" },
  { value: "below", label: "Below" },
];

/** Create or edit an alert on one page: what is measured, the condition, who is told. */
export function AlertForm({
  projectId,
  rule,
  start,
  scorers,
  facets,
  destinations,
}: {
  projectId: string;
  /** Null: a new one. */
  rule: AlertRule | null;
  /** What a new one measures at first. */
  start: AlertQuery | null;
  scorers: readonly ScorerOption[] | null;
  facets: TraceFilterBarFacets;
  destinations: readonly AlertDestination[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState<AlertQuery>(() => startQuery(rule?.query ?? start));
  const [name, setName] = useState(rule?.name ?? "");
  const [operator, setOperator] = useState<AlertOperator>(rule?.operator ?? "above");
  const unit = getMetric(query.metric)?.unit ?? "count";
  const [thresholdText, setThresholdText] = useState(
    rule ? thresholdInput(rule.threshold, unit) : "",
  );
  const [windowMinutes, setWindowMinutes] = useState<AlertWindow>(rule?.windowMinutes ?? 15);
  const [chosen, setChosen] = useState<readonly string[]>(
    () =>
      rule?.destinationIds ??
      // One destination is the usual answer.
      (destinations.length === 1 ? [destinations[0].id] : []),
  );
  const [thresholdMissing, setThresholdMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const threshold = thresholdFrom(thresholdText, unit);
  const defaultName = metricText(query);

  function changeQuery(change: Partial<AlertQuery>) {
    const next = queryOf(changedWidget(widgetOf(query), change, scorers ?? []));
    // A threshold in another unit is another threshold.
    if (getMetric(next.metric)?.unit !== unit) setThresholdText("");
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
      destinationIds: [...chosen],
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
          <MetricFields query={query} scorers={scorers} onChange={changeQuery} />
          <MetricFilter
            query={query}
            facets={facets}
            onChange={(next) =>
              setQuery((current) => ({ ...current, filter: next(current.filter) }))
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
          <AlertPreviewChart
            projectId={projectId}
            query={query}
            windowMinutes={windowMinutes}
            threshold={threshold}
          />
        </div>
      </Section>

      <Section title="3. Notify">
        <div className="flex flex-col gap-4">
          {destinations.length > 0 ? (
            <div className="flex flex-col gap-2">
              {destinations.map(({ id, name: label }) => (
                <Checkbox
                  key={id}
                  label={`Slack: ${label}`}
                  checked={chosen.includes(id)}
                  onCheckedChange={(checked) =>
                    setChosen((current) =>
                      checked ? [...current, id] : current.filter((other) => other !== id),
                    )
                  }
                />
              ))}
            </div>
          ) : null}
          {chosen.length === 0 ? (
            <Callout tone="warning" title="This alert notifies nobody">
              {destinations.length > 0 ? (
                "Its state and history are still recorded."
              ) : (
                <>
                  Its state and history are still recorded.{" "}
                  <Link
                    href={`${projectSettingsRoot(projectId)}/notifications`}
                    className="underline"
                  >
                    Add a Slack destination
                  </Link>
                </>
              )}
            </Callout>
          ) : null}
          <Field label="Name" description="The title of the message.">
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

/** A metric that left the catalog cannot be edited: the form starts again. */
function startQuery(query: AlertQuery | null): AlertQuery {
  return query && getMetric(query.metric) ? query : DEFAULT_QUERY;
}

/** The query as the widget rules read it. */
function widgetOf(query: AlertQuery): WidgetInput {
  return { ...query, title: "", groupBy: null, chart: "line", width: "full" };
}

function queryOf({ metric, aggregation, filter, scorerId }: WidgetInput): AlertQuery {
  return { metric, aggregation, filter, ...(scorerId ? { scorerId } : {}) };
}
