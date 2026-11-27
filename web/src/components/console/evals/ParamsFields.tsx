"use client";

import { Switch } from "@ratel/design-system/checkbox";
import { Field, Input } from "@ratel/design-system/input";
import { MAX_COMBINATIONS } from "@/lib/views/evals/domain/eval";
import { type Errors, type MatrixDraft, matrixOf } from "@/lib/views/evals/eval-form";
import type { ParamDraft, ParamSpec } from "@/lib/views/sandboxes/run-form";
import { ParamControl } from "../sandboxes/ParamControl";

/**
 * The params of the runtime: a value for each (its default unless changed), and a "Matrix" switch
 * that takes several values for chosen params. A run has one variant for each combination, at
 * most 12; the count shows as the values change.
 */
export function ParamsFields({
  params,
  values,
  onValues,
  matrixOn,
  onMatrixOn,
  matrix,
  onMatrix,
  errors,
}: {
  params: readonly ParamSpec[];
  values: ParamDraft;
  onValues: (values: ParamDraft) => void;
  matrixOn: boolean;
  onMatrixOn: (on: boolean) => void;
  matrix: MatrixDraft;
  onMatrix: (matrix: MatrixDraft) => void;
  errors: Errors;
}) {
  if (params.length === 0) return null;
  const counted = matrixOn ? matrixOf(params, matrix) : null;
  const count = counted?.count ?? 0;
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="sr-only">Parameters</legend>
      {params.map((param) =>
        matrixOn ? (
          <Field
            key={param.name}
            label={<code className="font-mono">{param.name}</code>}
            description={
              param.type === "enum"
                ? `Values separated by commas, from: ${param.options.join(", ")}. Empty: the default.`
                : "Values separated by commas. Empty: the default."
            }
            error={errors[`matrix.${param.name}`] ?? errors[`params.${param.name}`]}
          >
            {(control) => (
              <Input
                {...control}
                value={matrix[param.name] ?? ""}
                placeholder={param.default === null ? "" : String(param.default)}
                onChange={(event) => onMatrix({ ...matrix, [param.name]: event.target.value })}
              />
            )}
          </Field>
        ) : (
          <ParamControl
            key={param.name}
            param={param}
            value={
              values[param.name] ??
              (param.type === "boolean" ? param.default === true : String(param.default ?? ""))
            }
            error={errors[`params.${param.name}`] ?? null}
            onChange={(value) => onValues({ ...values, [param.name]: value })}
          />
        ),
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Switch
          label="Matrix: try several values"
          checked={matrixOn}
          onCheckedChange={onMatrixOn}
        />
        {matrixOn ? (
          <span
            className={count > MAX_COMBINATIONS ? "text-xs text-danger" : "text-xs text-fg-subtle"}
            aria-live="polite"
          >
            {count} of at most {MAX_COMBINATIONS} combinations
          </span>
        ) : null}
      </div>
      {errors.matrix ? <p className="text-xs text-danger">{errors.matrix}</p> : null}
    </fieldset>
  );
}
