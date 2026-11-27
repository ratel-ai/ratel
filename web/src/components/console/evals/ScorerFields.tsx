"use client";

import { Button } from "@ratel/design-system/button";
import { Checkbox } from "@ratel/design-system/checkbox";
import { Input, Textarea } from "@ratel/design-system/input";
import { Section } from "@ratel/design-system/section";
import { Select } from "@ratel/design-system/select";
import { CHECK_OPERATORS, type CheckConfig, type CheckOperator } from "@/lib/contracts/check";
import type { CaseScorer } from "@/lib/views/evals/domain/case";

const OPERATORS: Record<CheckOperator, string> = {
  eq: "is",
  ne: "is not",
  contains: "contains",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  exists: "exists",
};
const PATHS = "output, tools, tool_arguments.<tool>.<field>, cost_usd, duration_ms";

/** The scorers of a draft: deterministic checks, and yes or no questions for a judge. */
export function ScorerFields({
  scorers,
  onChange,
  canEdit,
}: {
  scorers: CaseScorer[];
  onChange: (scorers: CaseScorer[]) => void;
  canEdit: boolean;
}) {
  const set = (id: string, next: CaseScorer) =>
    onChange(scorers.map((scorer) => (scorer.id === id ? next : scorer)));
  const add = (scorer: Omit<CaseScorer, "id">) =>
    onChange([...scorers, { ...scorer, id: crypto.randomUUID() }]);
  return (
    <Section
      title="Scorers"
      description="A gating scorer decides the result of a trial. The result of an advisory one is only stored."
    >
      {scorers.length > 0 ? (
        <ul className="divide-y divide-line rounded-lg border border-line bg-raised">
          {scorers.map((scorer) => (
            <li key={scorer.id} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <Input
                  aria-label="Scorer name"
                  value={scorer.name}
                  disabled={!canEdit}
                  className="w-56"
                  onChange={(event) => set(scorer.id, { ...scorer, name: event.target.value })}
                />
                <Checkbox
                  label="Gating"
                  checked={scorer.gating}
                  disabled={!canEdit}
                  onCheckedChange={(gating) => set(scorer.id, { ...scorer, gating })}
                />
                {canEdit ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => onChange(scorers.filter(({ id }) => id !== scorer.id))}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
              <Definition
                scorer={scorer}
                canEdit={canEdit}
                onChange={(definition) => set(scorer.id, { ...scorer, definition })}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {canEdit ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              add({
                name: "Check",
                gating: true,
                definition: {
                  kind: "check",
                  config: { path: "output", op: "contains", value: "" },
                },
              })
            }
          >
            Add a check
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              add({
                name: "Judge",
                gating: false,
                definition: { kind: "judge", config: { prompt: "", output: "boolean" } },
              })
            }
          >
            Add a judge
          </Button>
        </div>
      ) : null}
    </Section>
  );
}

/** A scorer in words. */
export function scorerSentence({ name, gating, definition }: CaseScorer): string {
  const what =
    definition.kind === "judge"
      ? `judge: ${definition.config.prompt}`
      : `${definition.config.path} ${OPERATORS[definition.config.op]} ${definition.config.value ?? ""}`;
  return `${name} (${gating ? "gating" : "advisory"}): ${what.trim()}`;
}

function Definition({
  scorer,
  canEdit,
  onChange,
}: {
  scorer: CaseScorer;
  canEdit: boolean;
  onChange: (definition: CaseScorer["definition"]) => void;
}) {
  const { definition } = scorer;
  if (definition.kind === "judge") {
    return (
      <Textarea
        aria-label="Yes or no question"
        rows={2}
        value={definition.config.prompt}
        placeholder="Does the answer refuse the refund?"
        disabled={!canEdit}
        onChange={(event) =>
          onChange({ kind: "judge", config: { prompt: event.target.value, output: "boolean" } })
        }
      />
    );
  }
  const config: CheckConfig = definition.config;
  const change = (next: Partial<CheckConfig>) => {
    const { value = "", ...rest } = { ...config, ...next };
    onChange({ kind: "check", config: rest.op === "exists" ? rest : { ...rest, value } });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        aria-label="What the check reads"
        title={PATHS}
        placeholder={PATHS}
        value={config.path}
        spellCheck={false}
        disabled={!canEdit}
        className="w-72 font-mono"
        onChange={(event) => change({ path: event.target.value })}
      />
      <Select
        aria-label="Operator"
        value={config.op}
        disabled={!canEdit}
        onValueChange={(op) => change({ op: op as CheckOperator })}
        options={CHECK_OPERATORS.map((op) => ({ value: op, label: OPERATORS[op] }))}
        className="w-36"
      />
      {config.op === "exists" ? null : (
        <Input
          aria-label="Value"
          value={String(config.value ?? "")}
          disabled={!canEdit}
          className="w-56 font-mono"
          onChange={(event) => change({ value: event.target.value })}
        />
      )}
    </div>
  );
}
