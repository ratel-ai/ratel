"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { Field, Input, Textarea } from "@ratel/design-system/input";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { Callout } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CaseScorer } from "@/lib/views/evals/domain/case";
import type { CaseEditorModel, CaseVersionView } from "@/lib/views/evals/page-model";
import { caseHref, evalsHref } from "@/lib/views/evals/paths";
import { ScorerFields, scorerSentence } from "./ScorerFields";

const JSON_FIELDS = [
  ["input", "Input (JSON)", 4],
  ["earlierTurns", "Earlier turns (JSON, the agent gets them as params.earlierTurns)", 3],
  ["toolFixtures", "Tool fixtures (JSON)", 6],
] as const;
type JsonField = (typeof JSON_FIELDS)[number][0];

/** The draft of a case. With no draft, the approved version is the start of the next one. */
export function CaseEditor({ model }: { model: CaseEditorModel }) {
  const { projectId, canEdit, approved, draft } = model;
  const router = useRouter();
  const start = draft ?? approved;
  const [name, setName] = useState(model.name);
  const [labels, setLabels] = useState(model.labels.join(", "));
  const [json, setJson] = useState<Record<JsonField, string>>({
    input: show(start ? start.input : { message: "" }),
    earlierTurns: show(start?.earlierTurns ?? []),
    toolFixtures: show(start?.toolFixtures ?? []),
  });
  const [expectedOutput, setExpectedOutput] = useState(start?.expectedOutput ?? "");
  const [scorers, setScorers] = useState<CaseScorer[]>(start?.scorers ?? []);
  const [errors, setErrors] = useState<Partial<Record<JsonField, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  /** The saved draft, or null when there is nothing to approve. */
  async function save(): Promise<{ caseId: string; draft: Draft | null } | null> {
    const content: Record<string, unknown> = { expectedOutput: expectedOutput || null, scorers };
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
    return send(
      model.id ? "PUT" : "POST",
      `/api/projects/${projectId}/evals/cases${model.id ? `/${model.id}` : ""}`,
      { name, labels: labelsOf(labels), content },
    );
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

  async function run(approve: boolean) {
    setPending(true);
    try {
      const saved = await save();
      if (!saved) return;
      const open = () =>
        model.id ? router.refresh() : router.replace(caseHref(projectId, saved.caseId));
      if (approve && saved.draft) {
        const done = await send(
          "POST",
          `/api/projects/${projectId}/evals/cases/${saved.caseId}/approve`,
          { versionId: saved.draft.versionId, updatedAt: saved.draft.updatedAt },
        );
        if (!done) return open();
        toast({ title: `Version ${saved.draft.number} is approved`, tone: "success" });
      } else {
        toast({
          title: saved.draft ? "Draft saved" : "Saved. No change to approve.",
          tone: "success",
        });
      }
      open();
    } finally {
      setPending(false);
    }
  }

  return (
    <Page>
      <PageHeader
        title={model.name || "New case"}
        crumbs={[{ label: "Evals", href: evalsHref(projectId) }]}
        actions={
          canEdit ? (
            <>
              <Button variant="secondary" disabled={pending} onClick={() => run(false)}>
                Save draft
              </Button>
              <Button variant="primary" disabled={pending} onClick={() => run(true)}>
                Approve
              </Button>
            </>
          ) : null
        }
      />
      <PageBody>
        {problem ? (
          <Callout tone="danger" title="Not saved">
            {problem}
          </Callout>
        ) : null}
        <Status projectId={projectId} approved={approved} draft={draft} />
        <Section title="Case">
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
        <ScorerFields scorers={scorers} onChange={setScorers} canEdit={canEdit} />
        {draft && approved ? <Frozen version={approved} /> : null}
      </PageBody>
    </Page>
  );
}

type Draft = { versionId: string; number: number; updatedAt: string };

function Status({
  projectId,
  approved,
  draft,
}: {
  projectId: string;
  approved: CaseVersionView | null;
  draft: CaseVersionView | null;
}) {
  const source = (draft ?? approved)?.sourceTurnId;
  return (
    <div className="flex flex-wrap items-center gap-3 text-ui text-fg-muted">
      {approved ? <Badge tone="success">Approved v{approved.number}</Badge> : null}
      {draft ? <Badge tone="neutral">Draft v{draft.number}</Badge> : null}
      <span>
        {approved
          ? `Version ${approved.number} counts in eval runs. An edit makes a new draft.`
          : "This case does not count in eval runs until you approve it."}
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

/** The version that counts now, while a draft is open. */
function Frozen({ version }: { version: CaseVersionView }) {
  return (
    <Section
      title={`Approved version ${version.number}`}
      description="It stays the version that counts until you approve the draft."
    >
      <pre className="max-h-60 max-w-2xl overflow-auto rounded-md border border-line bg-rail p-3 font-mono text-xs whitespace-pre-wrap text-fg-muted">
        {show(version.input)}
      </pre>
      <ul className="text-ui text-fg-muted">
        {version.scorers.map((scorer) => (
          <li key={scorer.id}>{scorerSentence(scorer)}</li>
        ))}
      </ul>
    </Section>
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
