import { CodeBlock } from "@ratel/design-system/code";
import { Steps } from "@ratel/design-system/steps";
import type { ChecklistStep } from "@/lib/views/adaptive-ranking/ranking";

/**
 * The way to a served graph as a numbered checklist, always open. The step to
 * do now (or the one that is wrong) carries the lines to paste.
 */
export function SetupSteps({
  steps,
  label = "Setup steps",
}: {
  steps: readonly ChecklistStep[];
  label?: string;
}) {
  return (
    <Steps
      label={label}
      steps={steps.map((step) => ({
        id: step.key,
        title: step.title,
        description: step.detail,
        state: step.state,
        children:
          step.snippet && (step.state === "current" || step.state === "problem") ? (
            <CodeBlock caption="Runtime" samples={[{ label: "TypeScript", code: step.snippet }]} />
          ) : undefined,
      }))}
    />
  );
}
