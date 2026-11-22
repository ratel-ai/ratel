"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { Checkbox } from "@ratel/design-system/checkbox";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Field, Input } from "@ratel/design-system/input";
import { Section } from "@ratel/design-system/section";
import { Select } from "@ratel/design-system/select";
import { StatRow } from "@ratel/design-system/stat-row";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { Database } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { formatInteger } from "@/lib/synthesis/traces/v2/format";
import type { DatasetStatus, DatasetView } from "@/lib/views/fine-tuning/domain/dataset";
import type { RedactionKind } from "@/lib/views/fine-tuning/domain/redaction";
import type { DropReason } from "@/lib/views/fine-tuning/domain/rows";
import { SCORER_LABELS } from "@/lib/views/task-scorers/labels";
import { SCORER_KINDS, type ScorerKind } from "@/lib/views/task-scorers/types";

/** How often the page re-reads while a version is building. */
const POLL_MS = 2_000;

const STATUS_TONE: Record<DatasetStatus, "info" | "success" | "danger"> = {
  building: "info",
  ready: "success",
  failed: "danger",
};
const STATUS_LABEL: Record<DatasetStatus, string> = {
  building: "Building",
  ready: "Ready",
  failed: "Failed",
};

const DROP_LABELS: Record<DropReason, string> = {
  excluded: "Excluded by you",
  scorer_failed: "Failed a task scorer",
  user_scorer_failed: "Failed one of your scorers",
  error: "Run had an error",
  self_correction: "Run self-corrected",
  no_content: "No captured text",
  no_output: "No reply",
  duplicate_exact: "Exact duplicate",
  duplicate_near: "Near duplicate",
};

const REDACTION_LABELS: Record<RedactionKind, string> = {
  email: "Email addresses",
  phone: "Phone numbers",
  payment_card: "Payment cards",
  iban: "IBANs",
  national_id: "National ids",
  secret: "Keys and tokens",
};

/**
 * Builds a dataset version of one use case (RC-1129): the settings form. With
 * no training opt-in it is disabled and says where to give it.
 */
export function DatasetBuildForm({
  apiHref,
  consentGiven,
  consentHref,
}: {
  apiHref: string;
  consentGiven: boolean;
  consentHref: string;
}) {
  const router = useRouter();
  const [noError, setNoError] = useState(false);
  const [noSelfCorrection, setNoSelfCorrection] = useState(false);
  const [scorersOn, setScorersOn] = useState(true);
  const [dedup, setDedup] = useState("near");
  const [evalPercent, setEvalPercent] = useState("10");
  const [seed, setSeed] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const disabled = !consentGiven || pending;

  function build() {
    setError(null);
    const body = {
      filters: { noError, noSelfCorrection },
      scorers: scorersOn ? "on" : "off",
      dedup,
      evalFraction: Number(evalPercent) / 100,
      seed: Number(seed),
    };
    startTransition(async () => {
      const response = await fetch(apiHref, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json().catch(() => null)) as {
        ok?: boolean;
        message?: string;
        dataset?: { id: string };
      } | null;
      if (!response.ok || !result?.ok || !result.dataset) {
        setError(result?.message ?? "The build did not start. Try again.");
        return;
      }
      router.push(`?dataset=${encodeURIComponent(result.dataset.id)}`, { scroll: false });
      router.refresh();
    });
  }

  return (
    <Section
      title="Build a dataset"
      description="Each build is a new version. A version never changes once it is built."
    >
      {consentGiven ? null : (
        <Callout
          tone="warning"
          title="The training opt-in is off"
          action={
            <Link className="text-ui font-medium text-accent-mark underline" href={consentHref}>
              Go to the opt-in
            </Link>
          }
        >
          An organization admin must agree that Ratel copies model call text into a dataset before
          anyone can build one.
        </Callout>
      )}
      <form
        className="flex flex-col gap-4 rounded-lg border border-line bg-raised p-4"
        onSubmit={(event) => {
          event.preventDefault();
          build();
        }}
      >
        <fieldset className="flex flex-wrap gap-x-6 gap-y-2" disabled={!consentGiven}>
          <legend className="mb-2 text-ui font-medium text-fg">Quality rules</legend>
          <span className="w-full text-ui text-fg-muted">
            Calls that share a session or an end user always land on the same side of the split.
          </span>
          <Checkbox
            label="Leave out runs that fail a scorer"
            checked={scorersOn}
            onCheckedChange={setScorersOn}
            disabled={!consentGiven}
          />
          <Checkbox
            label="Leave out runs with an error"
            checked={noError}
            onCheckedChange={setNoError}
            disabled={!consentGiven}
          />
          <Checkbox
            label="Leave out runs that self-corrected"
            checked={noSelfCorrection}
            onCheckedChange={setNoSelfCorrection}
            disabled={!consentGiven}
          />
        </fieldset>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Duplicates" className="min-w-44 flex-1">
            {(control) => (
              <Select
                id={control.id}
                aria-label="Duplicates"
                value={dedup}
                onValueChange={setDedup}
                disabled={!consentGiven}
                options={[
                  { value: "near", label: "Remove near and exact duplicates" },
                  { value: "exact", label: "Remove exact duplicates" },
                  { value: "off", label: "Keep duplicates" },
                ]}
              />
            )}
          </Field>
          <Field label="Eval share (%)" className="w-32">
            {(control) => (
              <Input
                {...control}
                type="number"
                min={0}
                max={50}
                step={1}
                value={evalPercent}
                onChange={(event) => setEvalPercent(event.target.value)}
                disabled={!consentGiven}
              />
            )}
          </Field>
          <Field label="Seed" className="w-28">
            {(control) => (
              <Input
                {...control}
                type="number"
                min={0}
                step={1}
                value={seed}
                onChange={(event) => setSeed(event.target.value)}
                disabled={!consentGiven}
              />
            )}
          </Field>
          <Button type="submit" variant="primary" loading={pending} disabled={disabled}>
            Build dataset
          </Button>
        </div>
      </form>
      {error ? <Callout tone="danger">{error}</Callout> : null}
    </Section>
  );
}

/** The use case's versions, newest first. A row opens its summary. While one builds, the page re-reads. */
export function DatasetVersions({
  datasets,
  selectedId,
}: {
  datasets: readonly DatasetView[];
  selectedId: string | null;
}) {
  const router = useRouter();
  const building = datasets.some((dataset) => dataset.status === "building");
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [building, router]);

  const columns: Column<DatasetView>[] = [
    {
      id: "version",
      header: "Version",
      width: "6rem",
      cell: (row) => <span className="font-medium text-fg">v{row.version}</span>,
    },
    {
      id: "status",
      header: "Status",
      width: "8rem",
      cell: (row) => <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>,
    },
    {
      id: "train",
      header: "Train rows",
      align: "right",
      width: "8rem",
      cell: (row) => (row.status === "ready" && row.counts ? formatInteger(row.counts.train) : "—"),
    },
    {
      id: "eval",
      header: "Eval rows",
      align: "right",
      width: "8rem",
      cell: (row) => (row.status === "ready" && row.counts ? formatInteger(row.counts.eval) : "—"),
    },
    {
      id: "created",
      header: "Started",
      hiddenBelow: "md",
      cell: (row) =>
        new Date(row.createdAt).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }),
    },
  ];

  return (
    <Section title="Versions">
      <DataTable
        caption="Dataset versions"
        columns={columns}
        rows={datasets}
        rowKey={(row) => row.id}
        selectedKey={selectedId}
        onRowOpen={(row) =>
          router.push(`?dataset=${encodeURIComponent(row.id)}`, { scroll: false })
        }
        empty={
          <EmptyState
            icon={Database}
            title="No dataset yet"
            description="Build the first version with the form above."
          />
        }
      />
    </Section>
  );
}

/** One version: its counts, what was left out and why, what redaction removed, and its settings. Never row text. */
export function DatasetSummary({ dataset }: { dataset: DatasetView }) {
  const title = `Version ${dataset.version}`;
  if (dataset.status === "building") {
    return (
      <Section title={title}>
        <Callout tone="info" title="Building">
          {dataset.counts?.calls
            ? `${formatInteger(dataset.counts.calls)} model calls read so far. `
            : ""}
          This page updates when the build finishes.
        </Callout>
      </Section>
    );
  }
  if (dataset.status === "failed") {
    return (
      <Section title={title}>
        <Callout tone="danger" title="The build failed">
          {dataset.failedMessage ?? "The build failed."}
        </Callout>
        <SettingsList dataset={dataset} />
      </Section>
    );
  }
  const counts = dataset.counts;
  // Fixed orders, so two versions read the same way.
  const dropped = counts
    ? (Object.keys(DROP_LABELS) as DropReason[])
        .map((reason): [DropReason, number] => [reason, counts.dropped[reason] ?? 0])
        .filter(([, n]) => n > 0)
    : [];
  const droppedTotal = dropped.reduce((sum, [, n]) => sum + n, 0);
  const report = dataset.redactionReport;
  const redaction = report
    ? (Object.keys(REDACTION_LABELS) as RedactionKind[]).map((kind): [RedactionKind, number] => [
        kind,
        report[kind] ?? 0,
      ])
    : [];
  const redactedTotal = redaction.reduce((sum, [, n]) => sum + n, 0);
  const scorerDrops = counts?.scorerDrops;
  const byScorer = scorerDrops
    ? SCORER_KINDS.flatMap((kind) => {
        const n = scorerDrops.byKind[kind];
        return n ? [{ kind, ...n }] : [];
      })
    : [];

  return (
    <Section
      title={title}
      description={
        dataset.contentHash ? `Content hash ${dataset.contentHash.slice(0, 12)}` : undefined
      }
    >
      <StatRow
        stats={[
          { label: "Train rows", value: formatInteger(counts?.train ?? 0) },
          { label: "Eval rows", value: formatInteger(counts?.eval ?? 0) },
          { label: "Left out", value: formatInteger(droppedTotal) },
          { label: "Values redacted", value: formatInteger(redactedTotal) },
        ]}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <CountTable
            caption="Left out, by reason"
            header="Reason"
            rows={dropped.map(([reason, n]) => ({ key: reason, label: DROP_LABELS[reason], n }))}
            empty="No model call was left out."
          />
          {byScorer.length > 0 && scorerDrops ? (
            <ScorerDropsTable rows={byScorer} runs={scorerDrops.runs} />
          ) : null}
        </div>
        <div className="flex flex-col gap-2">
          <CountTable
            caption="Redacted, by kind"
            header="Kind"
            rows={redaction.map(([kind, n]) => ({ key: kind, label: REDACTION_LABELS[kind], n }))}
            empty="Nothing to redact."
          />
          <p className="text-ui text-fg-muted">
            Redaction is pattern-based. It finds emails, phone numbers, payment cards, IBANs,
            national ids, keys and tokens. It does not find names or addresses.
          </p>
        </div>
      </div>
      <SettingsList dataset={dataset} />
    </Section>
  );
}

function CountTable({
  caption,
  header,
  rows,
  empty,
}: {
  caption: string;
  header: string;
  rows: { key: string; label: string; n: number }[];
  empty: string;
}) {
  const columns: Column<{ key: string; label: string; n: number }>[] = [
    { id: "label", header, cell: (row) => row.label },
    {
      id: "n",
      header: "Count",
      align: "right",
      width: "6rem",
      cell: (row) => formatInteger(row.n),
    },
  ];
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-ui font-medium text-fg">{caption}</h3>
      <DataTable
        caption={caption}
        columns={columns}
        rows={rows}
        rowKey={(row) => row.key}
        density="compact"
        empty={<p className="px-3 py-2 text-ui text-fg-muted">{empty}</p>}
      />
    </div>
  );
}

/** The runs and calls each task scorer left out. A run that fails two scorers is in both rows. */
function ScorerDropsTable({
  rows,
  runs,
}: {
  rows: { kind: ScorerKind; runs: number; calls: number }[];
  runs: number;
}) {
  const columns: Column<{ kind: ScorerKind; runs: number; calls: number }>[] = [
    { id: "scorer", header: "Scorer", cell: (row) => SCORER_LABELS[row.kind] },
    {
      id: "runs",
      header: "Runs",
      align: "right",
      width: "6rem",
      cell: (row) => formatInteger(row.runs),
    },
    {
      id: "calls",
      header: "Calls",
      align: "right",
      width: "6rem",
      cell: (row) => formatInteger(row.calls),
    },
  ];
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-ui font-medium text-fg">Failed a task scorer, by scorer</h3>
      <DataTable
        caption="Failed a task scorer, by scorer"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.kind}
        density="compact"
      />
      <p className="text-ui text-fg-muted">
        {formatInteger(runs)} {runs === 1 ? "run" : "runs"} in total. A run that fails two scorers
        is in both rows.
      </p>
    </div>
  );
}

function SettingsList({ dataset }: { dataset: DatasetView }) {
  const { settings } = dataset;
  const rules = [
    settings.scorers === "off" ? "scorers off" : "scorers",
    ...(settings.filters.noError ? ["no error"] : []),
    ...(settings.filters.noSelfCorrection ? ["no self-correction"] : []),
  ];
  const items: [string, string][] = [
    ["Quality rules", rules.join(", ")],
    [
      "Duplicates",
      { off: "kept", exact: "exact removed", near: "near and exact removed" }[settings.dedup],
    ],
    ["Kept together", "calls that share a session or an end user"],
    ["Eval share", `${Math.round(settings.evalFraction * 100)}%`],
    ["Seed", String(settings.seed)],
    [
      "Runs from",
      `${new Date(settings.window.since).toLocaleDateString()} to ${new Date(settings.window.until).toLocaleDateString()}`,
    ],
    ["Redaction rules", `version ${settings.redactionVersion}`],
  ];
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-ui">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-fg-muted">{label}</dt>
          <dd className="text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
