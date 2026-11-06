import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAnalystResponse } from "./analyst";
import type { AnalystContext } from "./context";
import {
  MOCK_ANALYST_MODEL,
  mockAnalystDelayMs,
  mockAnalystDeps,
  mockAnalystEnabled,
  mockJudgeEngine,
} from "./mock";
import { CAPTURED_DIAGNOSIS, CAPTURED_PROPOSALS } from "./mock-fixture";
import type { Candidate, CorpusEntry } from "./types";

function withEnv(vars: Record<string, string | undefined>, run: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const ENTRY: CorpusEntry = {
  entryId: "refund_payment",
  name: "refund_payment",
  searchable: "Reverses a ledger entry.",
  source: "runtime",
  matchesAgentDescription: true,
  tags: [],
};

const CANDIDATE: Candidate = {
  entryId: "refund_payment",
  name: "refund_payment",
  misses: 2,
  buried: 0,
  targeted: 2,
  distractions: 0,
  loss: 2,
  failures: [
    {
      query: "give the money back",
      ourRank: null,
      ourTop: "x",
      baselineTop: "refund_payment",
      targetSource: "invoked",
    },
    {
      query: "Give The Money Back",
      ourRank: null,
      ourTop: "x",
      baselineTop: "refund_payment",
      targetSource: "invoked",
    },
    {
      query: "issue a refund",
      ourRank: null,
      ourTop: "x",
      baselineTop: "refund_payment",
      targetSource: "invoked",
    },
  ],
};

const CONTEXT: AnalystContext = {
  projectName: "p",
  census: {
    selectionsEvaluated: 2,
    revealedN: 2,
    referenceN: 0,
    judgedN: 0,
    queriesCaptured: 2,
    truncated: false,
    attributionMode: "tool-id",
    invokedToolKey: null,
    revealedSource: "experiment-invocation",
    baselineArm: "legacy",
    servingArm: "ratel",
    tunedArm: "ratel",
  },
  retrieval: { stages: [], topK: null, samples: 0 },
  quality: [],
  gapNote: null,
  referenceAccuracy: null,
  corpus: [ENTRY],
  candidates: [CANDIDATE],
};

test("the mock refuses outside a local environment even when asked for", () => {
  withEnv({ MATCH_QUALITY_MOCK_ANALYST: "1", APP_ENV: "production" }, () => {
    assert.equal(mockAnalystEnabled(), false);
  });
});

test("an unrecognized environment fails closed", () => {
  withEnv({ MATCH_QUALITY_MOCK_ANALYST: "1", APP_ENV: "staging-two" }, () => {
    assert.equal(mockAnalystEnabled(), false);
  });
});

test("the mock stays off locally unless explicitly switched on", () => {
  withEnv({ MATCH_QUALITY_MOCK_ANALYST: undefined, APP_ENV: "development" }, () => {
    assert.equal(mockAnalystEnabled(), false);
  });
});

test("the mock turns on locally when switched on", () => {
  withEnv({ MATCH_QUALITY_MOCK_ANALYST: "1", APP_ENV: "development" }, () => {
    assert.equal(mockAnalystEnabled(), true);
  });
});

test("a nonsense or hostile delay falls back and is capped", () => {
  withEnv({ MATCH_QUALITY_MOCK_DELAY_MS: "not-a-number" }, () => {
    assert.equal(mockAnalystDelayMs(), 1_500);
  });
  withEnv({ MATCH_QUALITY_MOCK_DELAY_MS: "-1" }, () => {
    assert.equal(mockAnalystDelayMs(), 1_500);
  });
  withEnv({ MATCH_QUALITY_MOCK_DELAY_MS: "999999" }, () => {
    assert.equal(mockAnalystDelayMs(), 30_000);
  });
  withEnv({ MATCH_QUALITY_MOCK_DELAY_MS: "0" }, () => {
    assert.equal(mockAnalystDelayMs(), 0);
  });
});

test("the fallback keeps the candidate's own distinct phrasings", async () => {
  const deps = mockAnalystDeps(CONTEXT, async () => {});
  assert.equal(deps.model, MOCK_ANALYST_MODEL);
  const raw = await deps.complete("s", "u");
  const result = parseAnalystResponse(raw, new Set(["refund_payment"]));
  assert.equal(result.proposals.length, 1);
  const proposed = result.proposals[0].searchableDescription;
  assert.equal(
    proposed,
    "Reverses a ledger entry. Use when someone asks for give the money back. | Use cases: give the money back; issue a refund.",
  );
  // No "mocked locally" preamble on the payload: the run row carries `mocked` and
  // the surface prints one chip for it, so repeating the caveat on every proposal
  // spent a line of every card restating a fact about the whole page.
  assert.match(result.proposals[0].rationale, /Added the wording these searches actually used\./);
  // The caption is printed uncollapsed under every proposal, so its whole job is
  // to stay short; the phrase list it used to recite lives in `details`.
  assert.ok(result.proposals[0].rationale.length < 70);
  assert.match(result.proposals[0].details, /give the money back/);
  assert.doesNotMatch(result.proposals[0].rationale, /mock/i);
  assert.doesNotMatch(result.proposals[0].expectedEffect, /mock/i);
});

test("a mocked run offers no diagnosis, because there is none without a model", async () => {
  const deps = mockAnalystDeps(CONTEXT, async () => {});
  const result = parseAnalystResponse(await deps.complete("s", "u"), new Set(["refund_payment"]));
  assert.equal(result.diagnosis.headline, "");
});

test("the caption does not grow with the number of phrasings behind it", async () => {
  const single: Candidate = {
    ...CANDIDATE,
    failures: [CANDIDATE.failures[0]],
  };
  const one = parseAnalystResponse(
    await mockAnalystDeps({ ...CONTEXT, candidates: [single] }, async () => {}).complete("s", "u"),
    new Set(["refund_payment"]),
  );
  const many = parseAnalystResponse(
    await mockAnalystDeps(CONTEXT, async () => {}).complete("s", "u"),
    new Set(["refund_payment"]),
  );
  // One phrasing or five, the line under the proposal reads the same. Counting
  // in the caption is what made it a sentence about the evidence rather than
  // about the change.
  assert.equal(one.proposals[0].rationale, many.proposals[0].rationale);
  assert.doesNotMatch(one.proposals[0].rationale, /\d/);
});

test("re-running the mock does not stack use-case tails", async () => {
  const already: CorpusEntry = {
    ...ENTRY,
    searchable: "Reverses a ledger entry. | Use cases: something old",
  };
  const deps = mockAnalystDeps({ ...CONTEXT, corpus: [already] }, async () => {});
  const result = parseAnalystResponse(await deps.complete("s", "u"), new Set(["refund_payment"]));
  const proposed = result.proposals[0].searchableDescription;
  assert.equal(proposed.match(/Use cases:/g)?.length, 1, "one tail, not two");
  assert.doesNotMatch(proposed, /something old/);
});

test("a candidate with no captured query text gets no mock proposal", async () => {
  const blind: Candidate = {
    ...CANDIDATE,
    failures: [
      { query: null, ourRank: null, ourTop: "x", baselineTop: "y", targetSource: "reference" },
    ],
  };
  const deps = mockAnalystDeps({ ...CONTEXT, candidates: [blind] }, async () => {});
  const result = parseAnalystResponse(await deps.complete("s", "u"), new Set(["refund_payment"]));
  assert.deepEqual(result.proposals, []);
});

test("the stand-in replays the captured answer for an entry it covers", async () => {
  const covered: CorpusEntry = { ...ENTRY, entryId: "search_tasks", name: "search_tasks" };
  const candidate: Candidate = { ...CANDIDATE, entryId: "search_tasks", name: "search_tasks" };
  const deps = mockAnalystDeps(
    { ...CONTEXT, corpus: [covered], candidates: [candidate] },
    async () => {},
  );
  const result = parseAnalystResponse(await deps.complete("s", "u"), new Set(["search_tasks"]));

  assert.equal(result.proposals.length, 1);
  assert.equal(
    result.proposals[0].searchableDescription,
    CAPTURED_PROPOSALS.search_tasks.searchableDescription,
  );
  assert.equal(result.diagnosis.headline, CAPTURED_DIAGNOSIS);
  // The capture's reasoning now lives in `details`; `rationale` is the one-line
  // caption printed under the text, and its whole job is to stay short.
  assert.ok(result.proposals[0].details.length > 120, "the audit still argues its case");
  assert.ok(
    result.proposals[0].rationale.length < 120,
    "the caption stays readable under the proposed text",
  );
});

test("an entry the capture never saw falls back to the same shape, not to nothing", async () => {
  const deps = mockAnalystDeps(CONTEXT, async () => {});
  const result = parseAnalystResponse(await deps.complete("s", "u"), new Set(["refund_payment"]));

  assert.equal(result.proposals.length, 1);
  const proposed = result.proposals[0].searchableDescription;
  assert.match(proposed, /^Reverses a ledger entry\. Use when someone asks for /);
  assert.match(proposed, /\| Use cases: give the money back; issue a refund\./);
  // No captured diagnosis, because nothing captured was replayed.
  assert.equal(result.diagnosis.headline, "");
});

const corpusOf = (ids: string[]) =>
  ids.map((entryId) => ({
    entryId,
    name: entryId,
    searchable: entryId,
    source: "runtime",
    matchesAgentDescription: false,
    tags: [],
  }));

test("the mock judge reaches all three verdict outcomes", async () => {
  const cases = Array.from({ length: 8 }, (_, index) => ({
    id: `case-${index}`,
    query: `query ${index}`,
    assumed: "tool_a",
    shortlist: ["tool_a", "tool_b"],
    stratum: "disputed" as const,
  }));
  const verdicts = await mockJudgeEngine(async () => {}).judge(
    cases,
    corpusOf(["tool_a", "tool_b"]),
  );

  const abstained = verdicts.filter((v) => v.entryId === "");
  const agreed = verdicts.filter((v) => v.entryId === "tool_a");
  const disagreed = verdicts.filter((v) => v.entryId === "tool_b");
  assert.equal(verdicts.length, 8);
  assert.equal(abstained.length, 2);
  assert.equal(disagreed.length, 2);
  assert.equal(agreed.length, 4);
});

test("the mock judge never names an entry the catalog does not hold", async () => {
  const verdicts = await mockJudgeEngine(async () => {}).judge(
    [
      {
        id: "a",
        query: "q",
        assumed: "ghost_tool",
        shortlist: ["ghost_tool"],
        stratum: "disputed",
      },
      {
        id: "b",
        query: "q",
        assumed: "ghost_tool",
        shortlist: ["ghost_tool"],
        stratum: "disputed",
      },
    ],
    corpusOf(["tool_a"]),
  );
  // Index 0 abstains by rotation; the point is that nothing invented appears.
  assert.ok(verdicts.every((v) => v.entryId === "" || v.entryId === "tool_a"));
});
