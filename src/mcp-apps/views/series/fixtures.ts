import { costByDay, traceHealth } from "../../harness/data";
import { okResult, type ViewFixtures } from "../../shell/types";

const window = (days: number) => ({
  since: new Date(Date.parse("2026-11-12T00:00:00Z") - days * 86_400_000).toISOString(),
  until: "2026-11-12T00:00:00.000Z",
});

const spans = "otel_spans";
const health = (days: number, seed?: number) => traceHealth(days, seed);
const kpisOnly = { kpis: health(7).kpis };

/** Each bound tool has `<tool>`, `<tool> · dense` and `<tool> · empty` (views/bindings.test.ts checks). */
const fixtures: ViewFixtures = {
  get_cost_by_day: {
    tool: "get_cost_by_day",
    result: okResult(
      { source: "event_metrics", days: 14, series: costByDay(14) },
      { window: window(14) },
    ),
  },
  "get_cost_by_day · dense": {
    tool: "get_cost_by_day",
    result: okResult(
      { source: "event_metrics", days: 90, series: costByDay(90, 9) },
      { window: window(90) },
    ),
  },
  "get_cost_by_day · empty": {
    tool: "get_cost_by_day",
    result: okResult({ source: "event_metrics", days: 0, series: [] }, { window: window(14) }),
  },
  get_trace_health: {
    tool: "get_trace_health",
    input: { includeDaily: true },
    result: okResult({ source: spans, ...health(14) }, { window: window(14) }),
  },
  "get_trace_health · dense": {
    tool: "get_trace_health",
    input: { includeDaily: true },
    result: okResult({ source: spans, ...health(90, 21) }, { window: window(90) }),
  },
  "get_trace_health · empty": {
    tool: "get_trace_health",
    input: { includeDaily: true },
    result: okResult({ source: spans, ...health(0) }, { window: window(14) }),
  },
  "get_trace_health · no daily": {
    tool: "get_trace_health",
    result: okResult({ source: spans, ...kpisOnly }, { window: window(7) }),
  },
};

export default fixtures;
