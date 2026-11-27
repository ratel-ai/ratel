import { errorResult, okResult, type ViewFixtures } from "../../shell/types";

const COLUMNS = [
  { name: "model", type: "text" },
  { name: "calls", type: "integer" },
  { name: "cost", type: "number" },
];
const MODELS = ["claude-sonnet-5-5", "gpt-5.1", "claude-haiku-5", "gemini-3-pro"];

/** run_rql's results, as lib/mcp/operations/monitoring/rql.ts shapes them. */
const fixtures: ViewFixtures = {
  run_rql: {
    tool: "run_rql",
    input: {
      text: "select model, count(*) as calls, sum(cost_usd) as cost from events where type = 'llm_call' group by model order by cost desc",
    },
    result: okResult(
      {
        summary: "3 rows of 3 columns: model, calls, cost.",
        columns: COLUMNS,
        rows: [
          ["claude-sonnet-5-5", 1234, 18.4512],
          ["gpt-5.1", 310, 4.2],
          [null, 12, null],
        ],
        truncated: false,
      },
      { window: { since: "2026-11-24T12:00:00.000Z", until: "2026-11-25T12:00:00.000Z" } },
    ),
  },
  "run_rql · dense": {
    tool: "run_rql",
    result: okResult(
      {
        summary:
          "100 rows of 3 columns: model, calls, cost. The query had more rows than its limit: these are the first ones.",
        columns: COLUMNS,
        rows: Array.from({ length: 100 }, (_, index) => [
          `${MODELS[index % MODELS.length]}-${index}`,
          1000 - index,
          (1000 - index) / 7,
        ]),
        truncated: true,
      },
      { truncated: true },
    ),
  },
  "run_rql · empty": {
    tool: "run_rql",
    result: okResult({
      summary: "No row. The query has 3 columns.",
      columns: COLUMNS,
      rows: [],
      truncated: false,
    }),
  },
  "run_rql · error": {
    tool: "run_rql",
    result: errorResult(
      "invalid_params",
      'There is no column "modle" in the table events. Did you mean "model"?',
    ),
  },
};

export default fixtures;
