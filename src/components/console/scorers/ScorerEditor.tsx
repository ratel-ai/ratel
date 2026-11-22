"use client";

import { Button } from "@ratel/design-system/button";
import { Switch } from "@ratel/design-system/checkbox";
import { Disclosure } from "@ratel/design-system/disclosure";
import { Field, Input, Textarea } from "@ratel/design-system/input";
import { Section } from "@ratel/design-system/section";
import { Select } from "@ratel/design-system/select";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { editScorerAction } from "@/lib/views/scorers/actions";
import {
  CHECK_OPS,
  type CheckOp,
  DEFAULT_GOOD_THRESHOLD,
  type Scorer,
} from "@/lib/views/scorers/domain/types";
import { configOf, formOf, type ScorerForm, thresholdOf } from "@/lib/views/scorers/form";
import { KIND_HELP, KIND_LABELS } from "@/lib/views/scorers/view";

const OP_LABELS: Record<CheckOp, string> = {
  eq: "equals",
  ne: "does not equal",
  lt: "is less than",
  lte: "is at most",
  gt: "is more than",
  gte: "is at least",
  contains: "contains",
  not_contains: "does not contain",
  matches: "matches the pattern",
  not_matches: "does not match the pattern",
  exists: "is set",
  not_exists: "is not set",
};

const FIELDS =
  "latencyMs, costUsd, tokens.input, tokens.output, toolNames, toolCallCount, failedCalls, selfCorrections, endsWell, finalAnswer, text, messages.*.content, toolCalls.*.name, toolCalls.*.arguments.<name>, toolCalls.*.result, toolCalls.*.latencyMs";

/**
 * RC-615: the only place a scorer is edited: its name, switch, pass threshold
 * and config for its kind. RC-658: the order of the UX audit (RC-656, 2.7):
 * what it scores, then when it passes. One primary (Save scorer); Delete is a
 * quiet button at the far end.
 */
export function ScorerEditor({
  projectId,
  scorer,
  backHref,
}: {
  projectId: string;
  scorer: Scorer;
  backHref: string;
}) {
  const router = useRouter();
  const [form, setForm] = useState<ScorerForm>(() => formOf(scorer));
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [logicError, setLogicError] = useState<string | null>(null);
  const set = <K extends keyof ScorerForm>(key: K, value: ScorerForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  function save() {
    const config = configOf(scorer.kind, form);
    const goodThreshold = thresholdOf(form);
    if (!config.ok) return setMessage({ tone: "error", text: config.error });
    if (goodThreshold === null)
      return setMessage({
        tone: "error",
        text: "The pass threshold must be a number from 0 to 100.",
      });
    setMessage(null);
    startTransition(async () => {
      const result = await editScorerAction(projectId, {
        action: "save",
        scorerId: scorer.id,
        name: form.name,
        enabled: form.enabled,
        goodThreshold,
        config: config.config,
      });
      setMessage(
        result.ok
          ? { tone: "ok", text: "Scorer saved. The next scoring reads it." }
          : { tone: "error", text: result.error },
      );
      if (result.ok) router.refresh();
    });
  }

  function remove() {
    startTransition(async () => {
      const result = await editScorerAction(projectId, { action: "delete", scorerId: scorer.id });
      if (!result.ok) return setMessage({ tone: "error", text: result.error });
      router.push(backHref);
    });
  }

  return (
    <Section title={KIND_LABELS[scorer.kind]} description={KIND_HELP[scorer.kind]}>
      <form
        aria-label="Scorer settings"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <Field label="Name">
          {(control) => (
            <Input
              {...control}
              value={form.name}
              maxLength={120}
              required
              onChange={(event) => set("name", event.target.value)}
            />
          )}
        </Field>
        {scorer.kind === "check" ? (
          <div className="flex flex-wrap items-end gap-4">
            <Field label="Run field" className="min-w-60 flex-1">
              {(control) => (
                <Input
                  {...control}
                  className="font-mono"
                  value={form.path}
                  onChange={(event) => set("path", event.target.value)}
                />
              )}
            </Field>
            <Select
              aria-label="Operator"
              value={form.op}
              options={CHECK_OPS.map((op) => ({ value: op, label: OP_LABELS[op] }))}
              onValueChange={(op) => set("op", op as CheckOp)}
            />
            {form.op === "exists" || form.op === "not_exists" ? null : (
              <Field label="Value" className="w-56">
                {(control) => (
                  <Input
                    {...control}
                    className="font-mono"
                    value={form.value}
                    onChange={(event) => set("value", event.target.value)}
                  />
                )}
              </Field>
            )}
          </div>
        ) : scorer.kind === "expression" ? (
          <Field
            label="Rule (JSON)"
            description="True passes. A number from 0 to 1 is the score."
            error={logicError ?? undefined}
          >
            {(control) => (
              <Textarea
                {...control}
                className="min-h-40 font-mono"
                value={form.logic}
                onChange={(event) => set("logic", event.target.value)}
                onBlur={() => setLogicError(jsonError(form.logic))}
              />
            )}
          </Field>
        ) : scorer.kind === "judge" ? (
          <Field
            label="Criteria"
            description="The model reads the whole run: messages, tool calls with arguments and results, and the final answer."
          >
            {(control) => (
              <Textarea
                {...control}
                className="min-h-24"
                value={form.criteria}
                maxLength={5000}
                onChange={(event) => set("criteria", event.target.value)}
              />
            )}
          </Field>
        ) : (
          <div className="flex flex-col gap-4">
            <Field label="Question">
              {(control) => (
                <Input
                  {...control}
                  value={form.question}
                  maxLength={1000}
                  onChange={(event) => set("question", event.target.value)}
                />
              )}
            </Field>
            <Field label="Options" description="One a line, as id: label.">
              {(control) => (
                <Textarea
                  {...control}
                  className="min-h-24 font-mono"
                  value={form.options}
                  onChange={(event) => set("options", event.target.value)}
                />
              )}
            </Field>
            <Field label="Passing options" description="Option ids, separated by commas.">
              {(control) => (
                <Input
                  {...control}
                  className="font-mono"
                  value={form.pass}
                  onChange={(event) => set("pass", event.target.value)}
                />
              )}
            </Field>
          </div>
        )}
        {scorer.kind === "check" || scorer.kind === "expression" ? (
          <Disclosure title="Fields you can read" hint="latencyMs, costUsd, toolCalls, …">
            <p className="font-mono text-xs text-fg-muted" data-scorer-fields>
              {FIELDS}
            </p>
          </Disclosure>
        ) : null}
        <div
          className="flex flex-wrap items-end gap-6 border-t border-line pt-4"
          data-group="when-it-passes"
        >
          <Field
            label="Pass threshold (%)"
            description={`A run passes at this score or more. Default: ${Math.round(DEFAULT_GOOD_THRESHOLD * 100)}%.`}
            className="w-52"
          >
            {(control) => (
              <Input
                {...control}
                inputMode="decimal"
                value={form.threshold}
                onChange={(event) => set("threshold", event.target.value)}
              />
            )}
          </Field>
          <Switch
            label="On: every eval reads it"
            checked={form.enabled}
            onCheckedChange={(on) => set("enabled", on)}
            className="pb-1.5"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" size="sm" loading={pending}>
            Save scorer
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => router.push(backHref)}
          >
            Back
          </Button>
          <span className="flex-1" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-danger hover:text-danger"
            disabled={pending}
            onClick={remove}
          >
            Delete scorer
          </Button>
        </div>
        <p
          className={`text-xs ${message?.tone === "error" ? "text-danger" : "text-fg-subtle"}`}
          aria-live="polite"
          role={message?.tone === "error" ? "alert" : undefined}
        >
          {message?.text}
        </p>
      </form>
    </Section>
  );
}

/** One sentence when the rule is not valid JSON, else null (UX audit P5: checked when the field loses focus). */
function jsonError(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch {
    return "This is not valid JSON.";
  }
}
