"use client";

import { Select } from "@ratel/design-system/select";
import { useRouter } from "next/navigation";
import type { CompareChoice } from "@/lib/views/evals/page-model";
import { compareHref } from "@/lib/views/evals/paths";

const PINNED = "__pinned__";

/** Chooses the experiment to compare with. The pinned baseline is the default. */
export function ComparePicker({
  projectId,
  experimentId,
  choices,
  chosenId,
}: {
  projectId: string;
  experimentId: string;
  choices: CompareChoice[];
  chosenId: string | null;
}) {
  const router = useRouter();
  const options = [
    { value: PINNED, label: "Compare with the pinned baseline" },
    ...choices
      .filter((choice) => choice.id !== experimentId)
      .map((choice) => ({ value: choice.id, label: choice.label })),
  ];
  return (
    <Select
      aria-label="Compare with"
      value={chosenId ?? PINNED}
      onValueChange={(value) => {
        const base = compareHref(projectId, experimentId);
        router.push(value === PINNED ? base : `${base}?baseline=${value}`);
      }}
      options={options}
      className="w-80"
    />
  );
}
