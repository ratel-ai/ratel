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

const SUITE = "__suite__";

/**
 * Starts a run: a ready version, the suite (each eval of the sandbox) or one eval, the params that
 * differ from the defaults, trials for each case (empty: the trials of each eval), a name.
 */
export function RunEvals({
  projectId,
  versions,
  evals,
}: {
  projectId: string;
  versions: ReadyVersion[];
  /** The names of the evals of the project. */
  evals: string[];
}) {
  const [versionId, setVersionId] = useState(versions[0]?.id ?? "");
  const [chosen, setChosen] = useState(SUITE);
  const version = versions.find((candidate) => candidate.id === versionId) ?? versions[0];
  return (
    <Section
      title="Run suite"
      description="Runs each approved case of the chosen evals on your agent. Each trial has a new sandbox instance."
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
            <Field label="Evals">
              {(control) => (
                <Select
                  id={control.id}
                  aria-label="Evals"
                  value={chosen}
                  onValueChange={setChosen}
                  options={[
                    { value: SUITE, label: "The suite: each eval of this sandbox" },
                    ...evals.map((name) => ({ value: name, label: name })),
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
            evalName={chosen === SUITE ? null : chosen}
            evals={evals.length}
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
  evalName,
  evals,
}: {
  projectId: string;
  version: ReadyVersion;
  /** Null: the suite. */
  evalName: string | null;
  evals: number;
}) {
  const router = useRouter();
  const [trials, setTrials] = useState("");
  const [name, setName] = useState("");
  const [params, setParams] = useState<ParamDraft>(() => paramDraftOf(version.params));
  const [paramErrors, setParamErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
          ...(trials ? { trials: Number(trials) } : {}),
          // Only what the person changed: the other params are the defaults of each eval.
          params: changedParams(version, parsed.value),
          ...(evalName ? { evals: [evalName] } : {}),
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
        <Field label="Run name" className="w-full max-w-sm">
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
        <Field label="Trials for each case" className="w-44">
          {(control) => (
            <Input
              {...control}
              type="number"
              min={1}
              max={20}
              value={trials}
              placeholder="The eval's"
              onChange={(event) => setTrials(event.target.value)}
            />
          )}
        </Field>
        <Button
          variant="primary"
          className="mt-5"
          onClick={start}
          disabled={pending || evals === 0}
        >
          {pending ? "Starting…" : evalName ? `Run ${evalName}` : "Run suite"}
        </Button>
      </div>
      <p className={error ? "text-xs text-danger" : "text-xs text-fg-subtle"}>
        {error ??
          (evals === 0
            ? "No eval yet. Save a trace turn as an eval case, or make a new eval."
            : "Each eval uses its own params and trials, unless you change them here.")}
      </p>
    </>
  );
}

/** The params whose value is not the default of the version. */
function changedParams(
  version: ReadyVersion,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const defaults = new Map(version.params.map((param) => [param.name, param.default]));
  return Object.fromEntries(
    Object.entries(values).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(defaults.get(key) ?? null),
    ),
  );
}
