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
import { useScorers } from "@/components/console/scorers/ScorerPickerProvider";
import { projectSettingsRoot } from "@/lib/console/settings/tabs";
import { metricQuery, parseQuery } from "@/lib/contracts/query";
import { getMetric } from "@/lib/synthesis/metrics/catalog";
import type { TraceFilterBarFacets } from "@/lib/synthesis/traces/v2/filters";
import {
  alertWindowText,
  METRIC_TO_SQL_WARNING,
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
import { metricAsRql } from "@/lib/views/dashboards/edit-as-sql";
import {
  changeQuery,
  type QueryChange,
  queryName,
  sqlWidgetQuery,
} from "@/lib/views/dashboards/widget";
import { slackErrorText } from "@/lib/views/slack/errors";
import { Choice, MetricFields, MetricFilter } from "../dashboards/MetricFields";
import { SqlFields } from "../dashboards/SqlFields";
import { AlertPreviewChart } from "./AlertPreviewChart";

const DEFAULT_QUERY = metricQuery("error_rate", "rate");
/** What a new RQL alert starts from when its metric has no RQL form: one row, one number. */
const DEFAULT_SQL = "select count(*) as traces from traces where has_error";
const MODES = [
  { value: "form", label: "Metric" },
  { value: "sql", label: "SQL" },
] as const;
const OPERATORS: readonly { value: AlertOperator; label: string }[] = [
  { value: "above", label: "Above" },
  { value: "below", label: "Below" },
];

/** Create or edit an alert on one page: what is measured, the condition, who is told. */
export function AlertForm({
  projectId,
  rule,
  start,
  facets,
  destinations,
  slackLost,
}: {
  projectId: string;
  /** Null: a new one. */
  rule: AlertRule | null;
  /** What a new one measures at first. */
  start: AlertQuery | null;
  facets: TraceFilterBarFacets;
  destinations: readonly AlertDestination[];
  /** Channels of a Slack workspace that is not connected any more are among them. */
  slackLost: boolean;
}) {
  const router = useRouter();
  const scorers = useScorers();
  const [query, setQuery] = useState<AlertQuery>(() => startQuery(rule?.query ?? start));
  const [name, setName] = useState(rule?.name ?? "");
  /** The Watch switch made RQL text of a metric: the form says how its number differs. */
  const [converted, setConverted] = useState(false);
  const [operator, setOperator] = useState<AlertOperator>(rule?.operator ?? "above");
  // The number of RQL text has no unit: it is compared as it is.
  const unit = (query.kind === "metric" && getMetric(query.measures[0].measure)?.unit) || "count";
  const [thresholdText, setThresholdText] = useState(
    // A threshold without its query has no unit.
    rule?.query ? thresholdInput(rule.threshold, unit) : "",
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
  const defaultName = queryName(query);

  function edit(change: QueryChange) {
    if (query.kind !== "metric") return;
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
      <Section title={query.kind === "sql" ? "1. RQL value" : "1. Metric"}>
        <div className="flex flex-col gap-4">
          <Choice label="Watch">
            <SegmentedControl
              label="Watch"
              options={MODES}
              value={query.kind === "sql" ? "sql" : "form"}
              onValueChange={(mode) => {
                setThresholdText("");
                setConverted(mode === "sql" && query.kind === "metric");
                setQuery(mode === "sql" ? sqlOf(query) : DEFAULT_QUERY);
              }}
            />
          </Choice>
          {query.kind === "sql" && converted ? (
            <Callout tone="warning" title="Not the same number as the metric">
              {METRIC_TO_SQL_WARNING}
            </Callout>
          ) : null}
          {query.kind === "sql" ? (
            <SqlFields
              query={query}
              result={null}
              onChange={setQuery}
              window="The alert's window is its window."
            />
          ) : (
            <>
              <MetricFields query={query} onChange={edit} />
              <MetricFilter
                query={query}
                facets={facets}
                onChange={(next) =>
                  setQuery((current) =>
                    current.kind === "metric"
                      ? changeQuery(current, { filter: next(current.filters) }, scorers ?? [])
                      : current,
                  )
                }
              />
            </>
          )}
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
          <p className="text-xs text-fg-subtle">
            {query.kind === "sql"
              ? "The query runs over the last window, on traces by when they started. It must give one row with one number. An error marks the alert as failing: it does not fire."
              : alertWindowText(query.measures[0].aggregation)}
          </p>
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
          {slackLost ? (
            <Callout tone="danger" title="Slack is disconnected">
              Messages do not reach its channels.{" "}
              <Link href={`${projectSettingsRoot(projectId)}/notifications`} className="underline">
                Connect again
              </Link>
            </Callout>
          ) : null}
          {destinations.length > 0 ? (
            <div className="flex flex-col gap-2">
              {destinations.map(({ id, name: label, ...destination }) => (
                <Checkbox
                  key={id}
                  label={
                    destination.kind === "slack_channel" && destination.accessError && !slackLost
                      ? `Slack: ${label}. ${slackErrorText(destination.accessError)}`
                      : `Slack: ${label}`
                  }
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

/** A query the contract no longer allows cannot be edited: the form starts again. */
function startQuery(query: AlertQuery | null): AlertQuery {
  return query && parseQuery(query).ok ? query : DEFAULT_QUERY;
}

/**
 * The RQL text of the metric, when it has one. It is close to the metric, not the same number
 * (`METRIC_TO_SQL_WARNING`): the form shows the warning after the switch.
 */
function sqlOf(query: AlertQuery): AlertQuery {
  if (query.kind === "sql") return query;
  const rql = metricAsRql({ title: "", chart: "number", query }, "hour");
  return sqlWidgetQuery(rql.ok ? rql.text : DEFAULT_SQL);
}
