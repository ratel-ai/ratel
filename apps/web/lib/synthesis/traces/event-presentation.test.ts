import assert from "node:assert/strict";
import { test } from "node:test";
import { presentationFor } from "./event-presentation";

test("presentationFor returns the branded presentation for known event names", () => {
  assert.deepEqual(
    [
      "ratel.experiment.results",
      "ratel.experiment.comparison",
      "ratel.experiment.skip",
      "ratel.experiment.fallback",
      "ratel.experiment.drop",
      "ratel.experiment.outcome",
    ].map(presentationFor),
    [
      {
        label: "Results",
        description: "Arm results recorded",
        markerClass: "bg-green",
        badgeClass: "border-green/25 bg-green/8 text-green",
      },
      {
        label: "Comparison",
        description: "Serving and shadow results compared",
        markerClass: "bg-indigo-300",
        badgeClass: "border-indigo-300/25 bg-indigo-300/8 text-indigo-300",
      },
      {
        label: "Skip",
        description: "Arm evaluation skipped",
        markerClass: "bg-warm-muted",
        badgeClass: "border-warm-muted/25 bg-warm-muted/8 text-cream-dim",
      },
      {
        label: "Fallback",
        description: "Serving moved to another arm",
        markerClass: "bg-ctx-tools",
        badgeClass: "border-ctx-tools/25 bg-ctx-tools/8 text-ctx-tools",
      },
      {
        label: "Drop",
        description: "Arm result excluded",
        markerClass: "bg-coral",
        badgeClass: "border-coral/25 bg-coral/8 text-coral",
      },
      {
        label: "Outcome",
        description: "Delayed outcome recorded",
        markerClass: "bg-ctx-memory",
        badgeClass: "border-ctx-memory/25 bg-ctx-memory/8 text-ctx-memory",
      },
    ],
  );
});

test("presentationFor falls back for unknown experiment events", () => {
  assert.deepEqual(presentationFor("ratel.experiment.mystery"), {
    label: "mystery",
    description: "Experiment lifecycle event",
    markerClass: "bg-warm-muted",
    badgeClass: "border-warm-muted/25 bg-warm-muted/8 text-cream-dim",
  });
});

test("presentationFor strips the Ratel prefix from other unknown events", () => {
  assert.equal(presentationFor("ratel.tool.call").label, "tool.call");
});
