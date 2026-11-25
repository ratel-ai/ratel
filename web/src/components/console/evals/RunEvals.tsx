"use client";

import { Button } from "@ratel/design-system/button";
import { Field, Input } from "@ratel/design-system/input";
import { Section } from "@ratel/design-system/section";
import { Select } from "@ratel/design-system/select";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ReadyVersion } from "@/lib/views/evals/page-model";
import { experimentHref } from "@/lib/views/evals/paths";

const DEFAULT_TRIALS = 3;

/** Starts an experiment with the approved cases on a ready sandbox version. */
export function RunEvals({
  projectId,
  versions,
  approved,
}: {
  projectId: string;
  versions: ReadyVersion[];
  /** The number of approved cases. */
  approved: number;
}) {
  const router = useRouter();
  const [versionId, setVersionId] = useState(versions[0]?.id ?? "");
  const [trials, setTrials] = useState(String(DEFAULT_TRIALS));
  const [params, setParams] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const runs = approved * (Number(trials) || 0);

  async function start() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(params);
    } catch {
      setError("The params must be JSON.");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/evals/experiments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sandboxVersion: versionId,
          trials: Number(trials),
          params: parsed,
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
    <Section
      title="Run evals"
      description="Runs each approved case on your agent. Each trial has a new sandbox instance."
    >
      {versions.length === 0 ? (
        <p className="text-ui text-fg-muted">
          A run needs a sandbox version that is ready.{" "}
          <Link
            href={`/project/${projectId}/sandbox`}
            className="text-accent-fg underline-offset-2 hover:underline"
          >
            Open Ratel sandbox
          </Link>
        </p>
      ) : (
        <div className="flex flex-wrap items-start gap-3">
          <Field label="Sandbox version" className="w-full max-w-md">
            {() => (
              <Select
                aria-label="Sandbox version"
                value={versionId}
                onValueChange={setVersionId}
                options={versions.map((version) => ({
                  value: version.id,
                  label: `${version.name} · ${version.commit.slice(0, 12)} · ${version.id.slice(0, 8)}`,
                }))}
                className="w-full"
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
          <Field label="Params (JSON)" className="w-56" error={error}>
            {(control) => (
              <Input
                {...control}
                value={params}
                spellCheck={false}
                className="font-mono"
                onChange={(event) => setParams(event.target.value)}
              />
            )}
          </Field>
          <Button
            variant="primary"
            className="mt-5"
            onClick={start}
            disabled={pending || approved === 0 || !versionId}
          >
            {pending ? "Starting…" : "Run evals"}
          </Button>
          <p className="w-full text-xs text-fg-subtle">
            {approved === 0
              ? "No case is approved yet."
              : `${approved} approved ${approved === 1 ? "case" : "cases"}, ${runs} trials.`}
          </p>
        </div>
      )}
    </Section>
  );
}
