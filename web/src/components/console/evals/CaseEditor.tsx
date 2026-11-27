"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { Field, Input, Textarea } from "@ratel/design-system/input";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { Select } from "@ratel/design-system/select";
import { Callout } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CaseEditorModel, CaseVersionView } from "@/lib/views/evals/page-model";
import { caseHref, evalsHref } from "@/lib/views/evals/paths";
import { scorerSentence } from "./ScorerFields";

const JSON_FIELDS = [
  ["input", "Input (JSON)", 4],
  ["earlierTurns", "Conversation history (JSON, the agent gets it as input.messages)", 3],
  ["toolFixtures", "Tool fixtures (JSON)", 6],
] as const;
type JsonField = (typeof JSON_FIELDS)[number][0];

/**
 * A case: the form starts from the version that counts, and a save adds a new version that counts
 * at once (decision `rows-count-at-once`).
 */
export function CaseEditor({ model }: { model: CaseEditorModel }) {
  const { projectId, canEdit, current: start } = model;
  const router = useRouter();
  const [base, setBase] = useState(start && { versionId: start.id });
  const [name, setName] = useState(model.name);
  const [labels, setLabels] = useState(model.labels.join(", "));
  const [json, setJson] = useState<Record<JsonField, string>>({
    input: show(start ? start.input : { message: "" }),
    earlierTurns: show(start?.earlierTurns ?? []),
    toolFixtures: show(start?.toolFixtures ?? []),
  });
  const [expectedOutput, setExpectedOutput] = useState(start?.expectedOutput ?? "");
  const [evalId, setEvalId] = useState(model.evalId ?? model.evals[0]?.id ?? "");
  const scorers = model.evals.find(({ id }) => id === evalId)?.scorers ?? [];
  const [errors, setErrors] = useState<Partial<Record<JsonField, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  /** The saved row, or null when it is not saved. */
  async function save(): Promise<Saved | null> {
    const content: Record<string, unknown> = { expectedOutput: expectedOutput || null };
    const wrong: Partial<Record<JsonField, string>> = {};
    for (const [field] of JSON_FIELDS) {
      try {
        content[field] = JSON.parse(json[field]);
      } catch {
        wrong[field] = "This must be JSON.";
      }
    }
    setErrors(wrong);
    if (Object.keys(wrong).length > 0) return null;
    const body = { name, labels: labelsOf(labels), content };
    if (model.id) {
      return send<Saved>("PUT", `/api/projects/${projectId}/evals/cases/${model.id}`, {
        ...body,
        base,
      });
    }
    const made = await send<{ cases: Saved[] }>("POST", `/api/projects/${projectId}/evals/cases`, {
      ...body,
      evalId,
    });
    return made?.cases[0] ?? null;
  }

  async function send<T>(method: string, url: string, body: unknown): Promise<T | null> {
    setProblem(null);
    try {
      const response = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const answer = (await response.json()) as T & { message?: string };
      if (response.ok) return answer;
      setProblem(answer.message ?? "The change was not saved. Try again.");
    } catch {
      setProblem("The change was not saved. Try again.");
    }
    return null;
  }

  async function run() {
    setPending(true);
    const saved = await save();
    if (!saved) return setPending(false);
    setBase({ versionId: saved.versionId });
    const changed = saved.number !== start?.number;
    toast({
      title: changed
        ? `Version ${saved.number} saved. It counts now.`
        : "Saved. The content did not change.",
      tone: "success",
    });
    // A new case stays pending until its page opens: a second click would make a second case.
    if (!model.id) return router.replace(caseHref(projectId, saved.caseId));
    router.refresh();
    setPending(false);
  }

  return (
    <Page>
      <PageHeader
        title={model.name || "New case"}
        crumbs={[{ label: "Evals", href: evalsHref(projectId) }]}
        actions={
          canEdit ? (
            <Button variant="primary" disabled={pending} onClick={run}>
              Save
            </Button>
          ) : null
        }
      />
      <PageBody>
        {problem ? (
          <Callout tone="danger" title="Not saved">
            {problem}
          </Callout>
        ) : null}
        <Status projectId={projectId} current={start} />
        <Section title="Case">
          {model.id ? null : (
            <Field label="Eval (its dataset gets the case)" className="w-full max-w-2xl">
              {() => (
                <Select
                  aria-label="Eval"
                  value={evalId}
                  onValueChange={setEvalId}
                  options={model.evals.map(({ id, name }) => ({ value: id, label: name }))}
                  disabled={!canEdit}
                />
              )}
            </Field>
          )}
          <Field label="Name" className="w-full max-w-2xl">
            {(control) => (
              <Input
                {...control}
                value={name}
                maxLength={200}
                disabled={!canEdit}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <Field label="Labels, with commas between them" className="w-full max-w-2xl">
            {(control) => (
              <Input
                {...control}
                value={labels}
                placeholder="task: refunds, intent: money back"
                disabled={!canEdit}
                onChange={(event) => setLabels(event.target.value)}
              />
            )}
          </Field>
          {JSON_FIELDS.map(([field, label, rows]) => (
            <Field key={field} label={label} error={errors[field]} className="w-full max-w-2xl">
              {(control) => (
                <Textarea
                  {...control}
                  rows={rows}
                  value={json[field]}
                  spellCheck={false}
                  disabled={!canEdit}
                  className="font-mono"
                  onChange={(event) => setJson({ ...json, [field]: event.target.value })}
                />
              )}
            </Field>
          ))}
          {start?.sourceOutput ? (
            <div className="flex max-w-2xl flex-col gap-1">
              <h3 className="text-xs font-medium text-fg-muted">The recorded answer</h3>
              <pre className="max-h-60 overflow-auto rounded-md border border-line bg-rail p-3 font-mono text-xs whitespace-pre-wrap text-fg-muted">
                {start.sourceOutput}
              </pre>
            </div>
          ) : null}
          <Field label="Expected output (the judge reads it)" className="w-full max-w-2xl">
            {(control) => (
              <Textarea
                {...control}
                rows={3}
                value={expectedOutput}
                disabled={!canEdit}
                onChange={(event) => setExpectedOutput(event.target.value)}
              />
            )}
          </Field>
        </Section>
        <Section title="Scorers" description="The scorers of the eval score each case of it.">
          {scorers.length > 0 ? (
            <ul className="text-ui text-fg-muted">
              {scorers.map((scorer) => (
                <li key={scorer.id}>{scorerSentence(scorer)}</li>
              ))}
            </ul>
          ) : (
            <p className="text-ui text-fg-muted">The eval has no scorer.</p>
          )}
        </Section>
      </PageBody>
    </Page>
  );
}

type Saved = { caseId: string; versionId: string; number: number };

function Status({ projectId, current }: { projectId: string; current: CaseVersionView | null }) {
  const source = current?.sourceTurnId;
  return (
    <div className="flex flex-wrap items-center gap-3 text-ui text-fg-muted">
      {current ? <Badge tone="success">v{current.number}</Badge> : null}
      <span>
        {current
          ? `Version ${current.number} counts in eval runs. A save adds a new version.`
          : "The case counts in eval runs when you save it."}
      </span>
      {source ? (
        <Link
          href={`/project/${projectId}/traces/turns/${source}`}
          className="text-accent-fg underline-offset-2 hover:underline"
        >
          Open the source turn
        </Link>
      ) : null}
    </div>
  );
}

function show(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

function labelsOf(text: string): string[] {
  return text
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}
