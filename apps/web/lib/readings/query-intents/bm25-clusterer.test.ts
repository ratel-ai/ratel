import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Bm25Clusterer,
  bm25ClustererFromEnv,
  type ClusterRunSummary,
} from "@/lib/readings/query-intents/bm25-clusterer";
import type { ClusterCandidate, ClusterCanonical } from "@/lib/readings/query-intents/clusterer";
import { normalizeIntent } from "@/lib/readings/query-intents/normalize";

const cand = (text: string): ClusterCandidate => ({ key: normalizeIntent(text), text });
const canon = (id: string, text: string, memberText = ""): ClusterCanonical => ({
  id,
  normalizedText: normalizeIntent(text),
  text,
  memberText,
});

test("the three Orbitals phrasings of one ask observed on staging merge into one cluster", async () => {
  // Same 3-message billing conversation, three consecutive extractor runs.
  const candidates = [
    cand("cancel their plan following the refund request"),
    cand("cancel their plan after the requested refund is processed"),
    cand("cancel their plan after receiving a refund for the double charge"),
  ];
  const out = await new Bm25Clusterer().cluster(candidates, []);
  const canonicals = new Set([...out.values()].map((a) => a.canonicalText));
  assert.equal(canonicals.size, 1, `expected one cluster, got ${[...canonicals].join(" | ")}`);
  assert.equal(
    [...canonicals][0],
    "cancel their plan following the refund request",
    "first member heads the cluster",
  );
});

test("a candidate joins an existing cluster through a MEMBER phrase the canonical text alone would miss", async () => {
  const existing = [
    canon(
      "ex1",
      "refund their order",
      "get a refund for their order\nrefund for a duplicate charge",
    ),
  ];
  const out = await new Bm25Clusterer().cluster([cand("refund a duplicate charge")], existing);
  assert.deepEqual(out.get(normalizeIntent("refund a duplicate charge")), {
    normalizedText: "refund their order",
    canonicalText: "refund their order",
  });

  // Without the member text the same candidate cannot clear the threshold.
  const bare = await new Bm25Clusterer().cluster(
    [cand("refund a duplicate charge")],
    [canon("ex1", "refund their order")],
  );
  assert.equal(
    bare.get(normalizeIntent("refund a duplicate charge"))!.canonicalText,
    "refund a duplicate charge",
  );
});

test("pure synonyms do not merge (documented lexical limit) unless a synonym map bridges them", async () => {
  const existing = [canon("ex1", "cancel their plan")];
  const separate = await new Bm25Clusterer().cluster([cand("stop billing")], existing);
  assert.equal(separate.get("stop billing")!.canonicalText, "stop billing");

  const subs = await new Bm25Clusterer().cluster([cand("cancel their subscription")], existing);
  assert.equal(
    subs.get(normalizeIntent("cancel their subscription"))!.canonicalText,
    "cancel their subscription",
  );

  const synonyms = new Map([["subscription", "plan"]]); // stemmed forms ("subscription" is left as-is by the stemmer)
  const bridged = await new Bm25Clusterer({ synonyms }).cluster(
    [cand("cancel their subscription")],
    existing,
  );
  assert.equal(
    bridged.get(normalizeIntent("cancel their subscription"))!.canonicalText,
    "cancel their plan",
  );
});

test("the reverse direction keeps a short phrase out of a long cluster that merely contains its words", async () => {
  const existing = [
    canon(
      "ex1",
      "deploy the payments service to production and verify the rollout status in the dashboard",
    ),
  ];
  const out = await new Bm25Clusterer().cluster([cand("verify the dashboard")], existing);
  // Forward relevance is 1 (both words appear), reverse is low — stays its own canonical.
  assert.equal(
    out.get(normalizeIntent("verify the dashboard"))!.canonicalText,
    "verify the dashboard",
  );
});

test("an ambiguous candidate stays a singleton and is counted", async () => {
  // Two existing clusters that are themselves near-duplicates: the candidate restates
  // both equally well, so guessing would be arbitrary.
  const existing = [
    canon("a", "export the report as a csv file"),
    canon("b", "export the report to a csv file"),
  ];
  let summary: ClusterRunSummary | undefined;
  const out = await new Bm25Clusterer({ onSummary: (s) => (summary = s) }).cluster(
    [cand("export the report as csv file")],
    existing,
  );
  assert.equal(
    out.get(normalizeIntent("export the report as csv file"))!.canonicalText,
    "export the report as csv file",
  );
  assert.equal(summary?.ambiguous, 1);
  assert.equal(summary?.singletons, 1);
  assert.equal(summary?.mergedExisting, 0);
});

test("assignments mirror the Jaccard contract: existing wins its text, same-run buckets take the first member's original text", async () => {
  const existing = [canon("ex1", "Search the codebase for a symbol")];
  const out = await new Bm25Clusterer().cluster(
    [
      cand("search the codebase for symbol usages"),
      cand("write unit tests for the parser after the refactor lands"),
      cand("write unit tests for the parser"),
    ],
    existing,
  );
  assert.equal(
    out.get(normalizeIntent("search the codebase for symbol usages"))!.canonicalText,
    "Search the codebase for a symbol",
  );
  const head = "write unit tests for the parser after the refactor lands";
  assert.equal(
    out.get(normalizeIntent(head))!.canonicalText,
    head,
    "the singleton keeps its unstripped text",
  );
  assert.equal(
    out.get(normalizeIntent("write unit tests for the parser"))!.canonicalText,
    head,
    "later member joins the same-run bucket",
  );
});

test("the run summary counts every outcome and the env constructor honours overrides", async () => {
  process.env.RATEL_INTENT_BM25_THRESHOLD = "0.95";
  try {
    let summary: ClusterRunSummary | undefined;
    const strict = bm25ClustererFromEnv({ onSummary: (s) => (summary = s) });
    const out = await strict.cluster(
      [cand("refund their order"), cand("refund their order today")],
      [],
    );
    // At 0.95 the second phrase's extra word keeps it out of the first bucket.
    assert.equal(new Set([...out.values()].map((a) => a.canonicalText)).size, 2);
    assert.equal(summary?.candidates, 2);
    assert.equal(summary?.singletons, 2);
    assert.ok((summary?.durationMs ?? -1) >= 0);
  } finally {
    delete process.env.RATEL_INTENT_BM25_THRESHOLD;
  }
});

test("empty input yields an empty map and a zero summary", async () => {
  let summary: ClusterRunSummary | undefined;
  const out = await new Bm25Clusterer({ onSummary: (s) => (summary = s) }).cluster(
    [],
    [canon("x", "anything")],
  );
  assert.equal(out.size, 0);
  assert.equal(summary?.seeds, 1);
  assert.equal(summary?.candidates, 0);
});

test("a candidate matching one RARE member of a large cluster joins it (the union-score prefilter dropped this)", async () => {
  const filler = Array.from(
    { length: 24 },
    (_, i) => `refund their order for invoice ${i} and confirm the receipt by email`,
  );
  const rare = "escalate the chargeback dispute to the payments team";
  const seeds = Array.from({ length: 60 }, (_, i) => canon(`s${i}`, `short seed ${i}`));
  const big = canon("big", "refund their order", [...filler, rare].join("\n"));
  const out = await new Bm25Clusterer().cluster(
    [cand("escalate the chargeback dispute")],
    [...seeds, big],
  );
  assert.equal(
    out.get(normalizeIntent("escalate the chargeback dispute"))!.canonicalText,
    "refund their order",
  );
});

test("the shortlist never changes an assignment: it agrees with brute-force per-phrase scoring", async () => {
  const { buildRelevanceIndex, tokenizeForRelevance } = await import(
    "@/lib/readings/query-intents/relevance"
  );
  const { stripTrailingContext } = await import("@/lib/readings/query-intents/intent-text");
  const verbs = [
    "deploy",
    "review",
    "search",
    "refund",
    "explain",
    "generate",
    "refactor",
    "cancel",
  ];
  const objects = [
    "the service",
    "the pull request",
    "the codebase",
    "their order",
    "this error",
    "unit tests",
    "the handler",
    "their plan",
  ];
  const tails = [
    "",
    " to production",
    " before merging",
    " for a symbol",
    " after the refund",
    " with retries",
    " so it compiles",
    " now",
  ];
  const phrase = (i: number) => `${verbs[i % 8]} ${objects[(i * 3) % 8]}${tails[(i * 5) % 8]}`;
  const existing = Array.from({ length: 30 }, (_, i) =>
    canon(`e${i}`, phrase(i), [phrase(i + 8), phrase(i + 16)].join("\n")),
  );
  const candidates = Array.from({ length: 40 }, (_, i) => cand(`${phrase(i * 7 + 3)} please`));

  const threshold = 0.6,
    margin = 0.1;
  const actual = await new Bm25Clusterer({ threshold, margin }).cluster(candidates, existing);

  // Brute force: same index construction, every bucket scored on every phrase, same
  // decision rules, same same-run growth — no shortlist at all.
  const clusterDoc = (e: ClusterCanonical) =>
    [e.text, ...(e.memberText ? e.memberText.split("\n") : [])].join("\n");
  const index = buildRelevanceIndex(
    [
      ...existing.map((e) => ({ id: `ex:${e.id}`, text: clusterDoc(e) })),
      ...candidates.map((c) => ({ id: `c:${c.key}`, text: stripTrailingContext(c.text) })),
    ],
    { tokenize: tokenizeForRelevance },
  );
  type B = { key: string; existing: ClusterCanonical | null; head: string; phrases: string[] };
  const buckets: B[] = existing.map((e) => ({
    key: `ex:${e.id}`,
    existing: e,
    head: e.text,
    phrases: [e.text, ...(e.memberText ? e.memberText.split("\n") : [])].map(stripTrailingContext),
  }));
  const expected = new Map<string, string>();
  for (const c of candidates) {
    const text = stripTrailingContext(c.text);
    const scored = buckets
      .map((b) => {
        let best = 0;
        for (const p of b.phrases) {
          const fwd = index.relevanceBetween(text, p);
          if (fwd < threshold || fwd <= best) continue;
          best = Math.max(best, Math.min(fwd, index.relevanceBetween(p, text)));
        }
        return { b, score: best };
      })
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score || x.b.key.localeCompare(y.b.key));
    const [first, second] = scored;
    if (
      first &&
      first.score >= threshold &&
      !(second && second.score >= threshold && first.score - second.score < margin)
    ) {
      first.b.phrases.push(text);
      expected.set(c.key, first.b.existing ? first.b.existing.text : first.b.head);
      continue;
    }
    buckets.push({ key: `c:${c.key}`, existing: null, head: c.text, phrases: [text] });
    expected.set(c.key, c.text);
  }
  for (const c of candidates)
    assert.equal(actual.get(c.key)!.canonicalText, expected.get(c.key), c.text);
});

test("an exact tie goes to the earlier seed (with margin 0); under the default margin it is ambiguous", async () => {
  const phrase = "escalate the chargeback dispute";
  const a = canon("ex-a", "handle a chargeback", phrase);
  const b = canon("ex-b", "dispute a card payment", phrase);
  const key = normalizeIntent(phrase);

  const first = await new Bm25Clusterer({ margin: 0 }).cluster([cand(phrase)], [a, b]);
  assert.equal(first.get(key)!.canonicalText, "handle a chargeback", "seed order decides");
  const reversed = await new Bm25Clusterer({ margin: 0 }).cluster([cand(phrase)], [b, a]);
  assert.equal(reversed.get(key)!.canonicalText, "dispute a card payment");

  const ambiguous = await new Bm25Clusterer().cluster([cand(phrase)], [a, b]);
  assert.equal(
    ambiguous.get(key)!.canonicalText,
    phrase,
    "a tie inside the margin stays a singleton",
  );
});
