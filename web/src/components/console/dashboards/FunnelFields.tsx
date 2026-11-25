"use client";

import { Button, IconButton } from "@ratel/design-system/button";
import { Input } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useId } from "react";
import {
  ATTRIBUTE_PREFIX,
  CHECK_OPERATORS,
  type CheckOperator,
  MAX_VALUE_CHARS,
  TRACE_FIELDS,
} from "@/lib/contracts/check";
import {
  FUNNEL_STEPS,
  type FunnelCondition,
  type FunnelOrder,
  type FunnelQuery,
  type FunnelStep,
  MAX_STEP_NAME,
} from "@/lib/contracts/query";
import type { TraceFilterBarFacets } from "@/lib/synthesis/traces/v2/filters";
import type { ScorerOption } from "@/lib/views/dashboards/types";
import { FIELD_LABELS, OPERATOR_LABELS } from "@/lib/views/scorers/format";
import { Choice } from "./MetricFields";

type ConditionType = FunnelCondition["type"];

const TYPE_LABELS: Readonly<Record<ConditionType, string>> = {
  tool: "Used a tool",
  skill: "Used a skill",
  attribute: "Attribute",
  scorer: "Scorer result",
  no_error: "No error",
};
const ATTRIBUTE = "attribute";
const SCORE_FLOORS = [2, 3, 4, 5] as const;

/** The steps of a funnel: 2 to 8, each a name and a condition, in the order they are drawn. */
export function FunnelFields({
  query,
  facets,
  scorers,
  onChange,
}: {
  query: FunnelQuery;
  facets: TraceFilterBarFacets;
  scorers: readonly ScorerOption[];
  onChange: (query: FunnelQuery) => void;
}) {
  const toolsId = useId();
  const { steps } = query;
  const setSteps = (next: FunnelStep[]) => onChange({ ...query, steps: next });
  const swap = (index: number, other: number) =>
    setSteps(steps.with(index, steps[other]).with(other, steps[index]));
  return (
    <div className="flex flex-col gap-3">
      <Choice label="Steps">
        <ol className="flex flex-col gap-2">
          {steps.map((step, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: a step is its position.
              key={index}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2"
            >
              <span className="w-5 text-center text-xs text-fg-subtle tabular-nums">
                {index + 1}
              </span>
              <Input
                aria-label={`Name of step ${index + 1}`}
                className="w-36"
                value={step.name}
                maxLength={MAX_STEP_NAME}
                autoComplete="off"
                onChange={(event) =>
                  setSteps(steps.with(index, { ...step, name: event.currentTarget.value }))
                }
              />
              <ConditionFields
                place={index + 1}
                condition={step.condition}
                scorers={scorers}
                toolsId={toolsId}
                onChange={(condition) => setSteps(steps.with(index, { ...step, condition }))}
              />
              <span className="ml-auto flex">
                <IconButton
                  label={`Move step ${index + 1} up`}
                  size="icon-sm"
                  icon={<ArrowUp />}
                  disabled={index === 0}
                  onClick={() => swap(index, index - 1)}
                />
                <IconButton
                  label={`Move step ${index + 1} down`}
                  size="icon-sm"
                  icon={<ArrowDown />}
                  disabled={index === steps.length - 1}
                  onClick={() => swap(index, index + 1)}
                />
                <IconButton
                  label={`Remove step ${index + 1}`}
                  size="icon-sm"
                  icon={<X />}
                  disabled={steps.length <= FUNNEL_STEPS.min}
                  onClick={() => setSteps(steps.toSpliced(index, 1))}
                />
              </span>
            </li>
          ))}
        </ol>
      </Choice>
      <datalist id={toolsId}>
        {facets.tool.map(({ value }) => (
          <option key={value} value={value} />
        ))}
      </datalist>
      <div className="flex flex-wrap items-end gap-4">
        <Choice label="Order">
          <SegmentedControl
            label="Order"
            options={[
              { value: "in_order", label: "In order" },
              { value: "any_order", label: "Any order" },
            ]}
            value={query.order}
            onValueChange={(order) => onChange({ ...query, order: order as FunnelOrder })}
          />
        </Choice>
        <Button
          variant="secondary"
          size="sm"
          disabled={steps.length >= FUNNEL_STEPS.max}
          onClick={() =>
            setSteps([
              ...steps,
              { name: `Step ${steps.length + 1}`, condition: { type: "no_error" } },
            ])
          }
        >
          <Plus className="size-3.5" aria-hidden />
          Add step
        </Button>
        <p className="text-xs text-fg-subtle">
          {FUNNEL_STEPS.min} to {FUNNEL_STEPS.max} steps. Order is the order of tool and skill uses.
        </p>
      </div>
    </div>
  );
}

function ConditionFields({
  place,
  condition,
  scorers,
  toolsId,
  onChange,
}: {
  place: number;
  condition: FunnelCondition;
  scorers: readonly ScorerOption[];
  toolsId: string;
  onChange: (condition: FunnelCondition) => void;
}) {
  const types = (Object.keys(TYPE_LABELS) as ConditionType[]).filter(
    (type) => type !== "scorer" || scorers.length > 0 || condition.type === "scorer",
  );
  return (
    <>
      <Select
        aria-label={`Condition of step ${place}`}
        className="w-36"
        options={types.map((value) => ({ value, label: TYPE_LABELS[value] }))}
        value={condition.type}
        onValueChange={(type) => onChange(newCondition(type as ConditionType, scorers))}
      />
      {condition.type === "tool" || condition.type === "skill" ? (
        <Input
          aria-label={`${condition.type === "tool" ? "Tool" : "Skill"} of step ${place}`}
          className="w-48"
          value={condition.name}
          list={condition.type === "tool" ? toolsId : undefined}
          maxLength={500}
          autoComplete="off"
          placeholder={condition.type === "tool" ? "Tool name" : "Skill name"}
          onChange={(event) => onChange({ ...condition, name: event.currentTarget.value })}
        />
      ) : null}
      {condition.type === "attribute" ? (
        <AttributeFields place={place} condition={condition} onChange={onChange} />
      ) : null}
      {condition.type === "scorer" ? (
        <ScorerFields place={place} condition={condition} scorers={scorers} onChange={onChange} />
      ) : null}
    </>
  );
}

function AttributeFields({
  place,
  condition,
  onChange,
}: {
  place: number;
  condition: Extract<FunnelCondition, { type: "attribute" }>;
  onChange: (condition: FunnelCondition) => void;
}) {
  const { path, op, value } = condition;
  const own = path.startsWith(ATTRIBUTE_PREFIX);
  return (
    <>
      <Select
        aria-label={`What step ${place} reads`}
        className="w-36"
        options={[
          ...TRACE_FIELDS.map((field) => ({ value: field as string, label: FIELD_LABELS[field] })),
          { value: ATTRIBUTE, label: "Attribute key" },
        ]}
        value={own ? ATTRIBUTE : path}
        onValueChange={(next) =>
          onChange({ ...condition, path: next === ATTRIBUTE ? ATTRIBUTE_PREFIX : String(next) })
        }
      />
      {own ? (
        <Input
          aria-label={`Attribute key of step ${place}`}
          className="w-36 font-mono text-xs"
          value={path.slice(ATTRIBUTE_PREFIX.length)}
          maxLength={180}
          autoComplete="off"
          placeholder="user.plan"
          onChange={(event) =>
            onChange({ ...condition, path: `${ATTRIBUTE_PREFIX}${event.currentTarget.value}` })
          }
        />
      ) : null}
      <Select
        aria-label={`Operator of step ${place}`}
        className="w-32"
        options={CHECK_OPERATORS.map((operator) => ({
          value: operator,
          label: OPERATOR_LABELS[operator],
        }))}
        value={op}
        onValueChange={(next) => {
          const { value: kept, ...rest } = condition;
          const operator = next as CheckOperator;
          onChange({
            ...rest,
            op: operator,
            ...(operator === "exists" ? {} : { value: kept ?? "" }),
          });
        }}
      />
      {op === "exists" ? null : (
        <Input
          aria-label={`Value of step ${place}`}
          className="w-32"
          value={String(value ?? "")}
          maxLength={MAX_VALUE_CHARS}
          autoComplete="off"
          placeholder="Value"
          onChange={(event) => onChange({ ...condition, value: event.currentTarget.value })}
        />
      )}
    </>
  );
}

function ScorerFields({
  place,
  condition,
  scorers,
  onChange,
}: {
  place: number;
  condition: Extract<FunnelCondition, { type: "scorer" }>;
  scorers: readonly ScorerOption[];
  onChange: (condition: FunnelCondition) => void;
}) {
  const { scorer, result, atLeast } = condition;
  const known = scorers.find(({ id }) => id === scorer.id);
  return (
    <>
      <Select
        aria-label={`Scorer of step ${place}`}
        className="w-44"
        options={[
          ...(known ? [] : [{ value: scorer.id, label: "Choose a scorer" }]),
          ...scorers.map(({ id, name }) => ({ value: id, label: name })),
        ]}
        value={scorer.id}
        onValueChange={(id) => {
          const next = scorers.find((option) => option.id === id);
          if (next) onChange(scorerCondition(next));
        }}
      />
      {result !== undefined ? (
        <Select
          aria-label={`Result of step ${place}`}
          className="w-28"
          options={[
            { value: "passed", label: "Passed" },
            { value: "failed", label: "Failed" },
          ]}
          value={result}
          onValueChange={(next) => onChange({ ...condition, result: next as "passed" | "failed" })}
        />
      ) : (
        <Select
          aria-label={`Least score of step ${place}`}
          className="w-28"
          options={SCORE_FLOORS.map((floor) => ({
            value: String(floor),
            label: `${floor} or more`,
          }))}
          value={String(atLeast)}
          onValueChange={(next) => onChange({ ...condition, atLeast: Number(next) })}
        />
      )}
    </>
  );
}

function newCondition(type: ConditionType, scorers: readonly ScorerOption[]): FunnelCondition {
  switch (type) {
    case "tool":
    case "skill":
      return { type, name: "" };
    case "attribute":
      return { type, path: "tools", op: "exists" };
    case "scorer":
      return scorers[0] ? scorerCondition(scorers[0]) : { type: "no_error" };
    case "no_error":
      return { type };
  }
}

function scorerCondition({ id, verdict }: ScorerOption): FunnelCondition {
  return {
    type: "scorer",
    scorer: { id },
    ...(verdict ? { result: "passed" } : { atLeast: 4 }),
  };
}
