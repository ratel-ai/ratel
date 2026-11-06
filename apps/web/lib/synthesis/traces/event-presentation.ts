export interface EventPresentation {
  label: string;
  description: string;
  markerClass: string;
  badgeClass: string;
}

export const EVENT_PRESENTATIONS: Readonly<Record<string, EventPresentation>> = {
  "ratel.experiment.results": {
    label: "Results",
    description: "Arm results recorded",
    markerClass: "bg-green",
    badgeClass: "border-green/25 bg-green/8 text-green",
  },
  "ratel.experiment.comparison": {
    label: "Comparison",
    description: "Serving and shadow results compared",
    markerClass: "bg-indigo-300",
    badgeClass: "border-indigo-300/25 bg-indigo-300/8 text-indigo-300",
  },
  "ratel.experiment.skip": {
    label: "Skip",
    description: "Arm evaluation skipped",
    markerClass: "bg-warm-muted",
    badgeClass: "border-warm-muted/25 bg-warm-muted/8 text-cream-dim",
  },
  "ratel.experiment.fallback": {
    label: "Fallback",
    description: "Serving moved to another arm",
    markerClass: "bg-ctx-tools",
    badgeClass: "border-ctx-tools/25 bg-ctx-tools/8 text-ctx-tools",
  },
  "ratel.experiment.drop": {
    label: "Drop",
    description: "Arm result excluded",
    markerClass: "bg-coral",
    badgeClass: "border-coral/25 bg-coral/8 text-coral",
  },
  "ratel.experiment.outcome": {
    label: "Outcome",
    description: "Delayed outcome recorded",
    markerClass: "bg-ctx-memory",
    badgeClass: "border-ctx-memory/25 bg-ctx-memory/8 text-ctx-memory",
  },
};

export function presentationFor(eventName: string): EventPresentation {
  return (
    EVENT_PRESENTATIONS[eventName] ?? {
      label: eventName.replace("ratel.experiment.", "").replace("ratel.", ""),
      description: "Experiment lifecycle event",
      markerClass: "bg-warm-muted",
      badgeClass: "border-warm-muted/25 bg-warm-muted/8 text-cream-dim",
    }
  );
}
