"use client";

import { Button } from "@ratel/design-system/button";
import { Field, Input } from "@ratel/design-system/input";
import { Section } from "@ratel/design-system/section";
import { Select } from "@ratel/design-system/select";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ParamControl } from "@/components/console/sandboxes/ParamControl";
import type { ReadyVersion } from "@/lib/views/evals/page-model";
import { experimentHref } from "@/lib/views/evals/paths";
import { type ParamDraft, paramDraftOf, paramsOfDraft } from "@/lib/views/sandboxes/run-form";

const DEFAULT_TRIALS = 3;
const ALL = "__all__";

/** Starts an experiment: a ready version, the cases of a label or all, typed params, trials, a name. */
export function RunEvals({
  projectId,
  versions,
  labels,
  label,
  onLabelChange,
  cases,
}: {
  projectId: string;
  versions: ReadyVersion[];
  /** The labels of the cases. */
  labels: string[];
  /** The label that chooses the cases. Null: all approved cases. */
  label: string | null;
  onLabelChange: (label: string | null) => void;
  /** The number of approved cases that the run takes. */
  cases: number;
}) {
  const [versionId, setVersionId] = useState(versions[0]?.id ?? "");
  const version = versions.find((candidate) => candidate.id === versionId) ?? versions[0];
  return (
    <Section
      title="Run evals"
      description="Runs each approved case on your agent. Each trial has a new sandbox instance."
    >
      {version ? (
        <div className="flex flex-col gap-4 rounded-lg border border-line bg-raised p-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Sandbox version">
              {(control) => (
                <Select
                  id={control.id}
                  aria-label="Sandbox version"
                  value={version.id}
                  onValueChange={setVersionId}
                  options={versions.map((candidate) => ({
                    value: candidate.id,
                    label: `${candidate.name} · ${candidate.commit.slice(0, 12)} · ${candidate.id.slice(0, 8)}`,
                  }))}
                  className="w-full"
                />
              )}
            </Field>
            <Field label="Cases">
              {(control) => (
                <Select
                  id={control.id}
                  aria-label="Cases"
                  value={label ?? ALL}
                  onValueChange={(value) => onLabelChange(value === ALL ? null : value)}
                  options={[
                    { value: ALL, label: "All approved cases" },
                    ...labels.map((name) => ({ value: name, label: `Label: ${name}` })),
                  ]}
                  className="w-full"
                />
              )}
            </Field>
          </div>
          <StartForm
            key={version.id}
            projectId={projectId}
            version={version}
            label={label}
            cases={cases}
          />
        </div>
      ) : (
        <p className="text-ui text-fg-muted">
          A run needs a sandbox version that is ready.{" "}
          <Link
            href={`/project/${projectId}/sandbox`}
            className="text-accent-fg underline-offset-2 hover:underline"
          >
            Open Ratel sandbox
          </Link>
        </p>
      )}
    </Section>
  );
}

function StartForm({
  projectId,
  version,
  label,
  cases,
}: {
  projectId: string;
  version: ReadyVersion;
  label: string | null;
  cases: number;
}) {
  const router = useRouter();
  const [trials, setTrials] = useState(String(DEFAULT_TRIALS));
  const [name, setName] = useState("");
  const [params, setParams] = useState<ParamDraft>(() => paramDraftOf(version.params));
  const [paramErrors, setParamErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const runs = cases * (Number(trials) || 0);

  async function start() {
    const parsed = paramsOfDraft(version.params, params);
    setParamErrors(parsed.ok ? {} : parsed.errors);
    if (!parsed.ok) return;
    setError(null);
    setPending(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/evals/experiments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sandboxVersion: version.id,
          trials: Number(trials),
          params: parsed.value,
          ...(label ? { label } : {}),
          ...(name.trim() ? { name: name.trim() } : {}),
        }),
      });
      const body = (await response.json()) as { experimentId?: string; message?: string };
      if (response.ok && body.experimentId) {
        router.push(experimentHref(projectId, body.experimentId));
        return;
      }
      setError(body.message ?? "The run did not start. Try again.");
    } catch {
      setError("The run did not start. Try again.");
    }
    setPending(false);
  }

  return (
    <>
      {version.params.length > 0 ? (
        <fieldset className="grid gap-x-4 gap-y-3 md:grid-cols-2">
          <legend className="mb-2 text-xs font-medium text-fg-muted">Parameters</legend>
          {version.params.map((param) => (
            <ParamControl
              key={param.name}
              param={param}
              value={params[param.name] ?? ""}
              error={paramErrors[param.name] ?? null}
              onChange={(value) => setParams({ ...params, [param.name]: value })}
            />
          ))}
        </fieldset>
      ) : (
        <p className="text-xs text-fg-subtle">This version declares no parameter.</p>
      )}
      <div className="flex flex-wrap items-start gap-3 border-t border-line pt-4">
        <Field label="Experiment name" className="w-full max-w-sm">
          {(control) => (
            <Input
              {...control}
              value={name}
              maxLength={200}
              placeholder="Refunds on the new prompt"
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        <Field label="Trials for each case" className="w-36">
          {(control) => (
            <Input
              {...control}
              type="number"
              min={1}
              max={20}
              value={trials}
              onChange={(event) => setTrials(event.target.value)}
            />
          )}
        </Field>
        <Button
          variant="primary"
          className="mt-5"
          onClick={start}
          disabled={pending || cases === 0}
        >
          {pending ? "Starting…" : "Run evals"}
        </Button>
      </div>
      <p className={error ? "text-xs text-danger" : "text-xs text-fg-subtle"}>
        {error ??
          (cases === 0
            ? label
              ? `No approved case has the label ${label}.`
              : "No case is approved yet."
            : `${cases} approved ${cases === 1 ? "case" : "cases"}${label ? ` with the label ${label}` : ""}, ${runs} trials.`)}
      </p>
    </>
  );
}
