import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilityIndexText, rankCapabilities } from "./rank";
import { BENCH_SKILL_DEFAULTS, BENCH_TOOL_DEFAULTS } from "./test-support";
import type { BenchSkill, BenchTool, RankOptions } from "./types";

/**
 * These run against the SDK's real native BM25, not a stub. A stub would let the
 * Playground's plumbing pass while disagreeing with what an agent retrieves,
 * the one failure this surface cannot afford, so the assertions stick to
 * properties that hold for any sane ranker (relative order, membership, bucket
 * independence) rather than exact scores, which are the engine's to change.
 */

const SKILLS: BenchSkill[] = [
  {
    ...BENCH_SKILL_DEFAULTS,
    id: "s1",
    name: "review-pull-request",
    description:
      "Review a pull request: summarize the diff, flag risky changes, and suggest improvements.",
    tags: ["git", "review"],
    tools: ["github_api"],
    status: "published",
    version: 1,
  },
  {
    ...BENCH_SKILL_DEFAULTS,
    id: "s2",
    name: "write-unit-tests",
    description:
      "Generate unit tests for a function or module, covering edge cases and error paths.",
    tags: ["testing"],
    tools: ["test_runner"],
    status: "published",
    version: 1,
  },
  {
    ...BENCH_SKILL_DEFAULTS,
    id: "s3",
    name: "explain-error",
    description: "Error tool.",
    tags: [],
    tools: [],
    status: "published",
    version: 1,
  },
];

const TOOLS: BenchTool[] = [
  {
    ...BENCH_TOOL_DEFAULTS,
    name: "github_api",
    description: "Read and write GitHub pull requests, issues and reviews.",
    hasDefinition: true,
    calls: 30,
  },
  {
    ...BENCH_TOOL_DEFAULTS,
    name: "test_runner",
    description: "Run the project's unit test suite and report failures.",
    hasDefinition: true,
    calls: 12,
  },
];

const options = (over: Partial<RankOptions> = {}): RankOptions => ({
  mode: "bm25",
  topKSkills: 5,
  topKTools: 5,
  embeddingWeight: 0.5,
  ...over,
});

const bm25Run = (query: string, over: Partial<RankOptions> = {}) =>
  rankCapabilities({
    query,
    skills: SKILLS,
    tools: TOOLS,
    editedSkillIds: new Set(),
    editedToolIds: new Set(),
    options: options(over),
  });

test("capabilityIndexText joins identity, prose and tags, skipping blanks", () => {
  assert.equal(
    capabilityIndexText({ name: "a", description: "b", tags: ["c", "d"] }),
    "a\nb\nc, d",
  );
  assert.equal(capabilityIndexText({ name: "a", description: "b", tags: [] }), "a\nb");
  assert.equal(capabilityIndexText({ name: "a", description: "" }), "a");
});

test("BM25 mode ranks the matching skill first", () => {
  const ranked = bm25Run("review a pull request");
  assert.ok(ranked.skills.length > 0);
  assert.equal(ranked.skills[0].id, "review-pull-request");
  assert.equal(ranked.skills[0].rank, 1);
  assert.ok(ranked.skills[0].score > 0);
});

test("BM25 mode omits capabilities that share no term with the prompt", () => {
  const ranked = bm25Run("review a pull request");
  // "explain-error" has a one-word description with nothing in common: a real
  // "not retrievable", which is different from a weak match.
  assert.equal(
    ranked.skills.some((hit) => hit.id === "explain-error"),
    false,
  );
});

test("skills and tools are ranked as independent buckets", () => {
  const ranked = bm25Run("run the unit test suite");
  assert.ok(ranked.skills.every((hit) => hit.kind === "skill"));
  assert.ok(ranked.tools.every((hit) => hit.kind === "tool"));
  // Each bucket ranks from 1, so a tool never consumes a skill's budget.
  if (ranked.skills.length > 0) assert.equal(ranked.skills[0].rank, 1);
  if (ranked.tools.length > 0) assert.equal(ranked.tools[0].rank, 1);
});

test("top-K is applied per bucket", () => {
  const ranked = bm25Run("test pull request review", {
    topKSkills: 1,
    topKTools: 1,
  });
  assert.ok(ranked.skills.length <= 1);
  assert.ok(ranked.tools.length <= 1);
});

const REWRITTEN =
  "Explain a runtime error or stack trace: identify the root cause, the failing line, and a concrete fix. Use when the user pastes an exception or asks why something is throwing.";

function withRewrittenErrorSkill(query: string) {
  return rankCapabilities({
    query,
    skills: SKILLS.map((skill) =>
      skill.name === "explain-error" ? { ...skill, description: REWRITTEN } : skill,
    ),
    tools: TOOLS,
    editedSkillIds: new Set(["explain-error"]),
    editedToolIds: new Set(),
    options: options(),
  });
}

test("rewriting a terse description makes an unreachable skill retrievable", () => {
  // The terse "Error tool." shares nothing with this phrasing, not even the
  // skill's own name, so BM25 returns it at all only after the rewrite. This
  // is the exact case the seeded catalog stages.
  const query = "why is this throwing a null pointer";
  assert.equal(
    bm25Run(query).skills.some((hit) => hit.id === "explain-error"),
    false,
  );

  const after = withRewrittenErrorSkill(query);
  const hit = after.skills.find((candidate) => candidate.id === "explain-error");
  assert.ok(hit, "expected the rewritten skill to be retrievable");
  assert.equal(hit.edited, true);
  assert.match(hit.description, /root cause/);
});

test("a richer description also raises the score on a query that already matched", () => {
  const query = "explain this stack trace";
  const before = bm25Run(query).skills.find((hit) => hit.id === "explain-error");
  const after = withRewrittenErrorSkill(query).skills.find((hit) => hit.id === "explain-error");
  assert.ok(before && after);
  assert.ok(
    after.score > before.score,
    `expected the rewrite to score higher (${before.score} → ${after.score})`,
  );
});

test("hits carry the description they were ranked with", () => {
  const ranked = bm25Run("review a pull request");
  assert.equal(ranked.skills[0].description, SKILLS[0].description);
});

test("an empty catalog ranks to empty buckets rather than throwing", () => {
  const ranked = rankCapabilities({
    query: "anything",
    skills: [],
    tools: [],
    editedSkillIds: new Set(),
    editedToolIds: new Set(),
    options: options(),
  });
  assert.deepEqual(ranked.skills, []);
  assert.deepEqual(ranked.tools, []);
});

/* Embeddings and hybrid modes */

const VECTORS = {
  query: [1, 0],
  skills: new Map([
    ["review-pull-request", [0, 1]],
    ["write-unit-tests", [0.5, 0.5]],
    ["explain-error", [1, 0]],
  ]),
  tools: new Map([
    ["github_api", [0, 1]],
    ["test_runner", [1, 0]],
  ]),
};

test("embeddings mode scores every capability, including BM25 non-matches", () => {
  const ranked = rankCapabilities({
    query: "review a pull request",
    skills: SKILLS,
    tools: TOOLS,
    editedSkillIds: new Set(),
    editedToolIds: new Set(),
    options: options({ mode: "embeddings" }),
    vectors: VECTORS,
  });
  assert.equal(ranked.skills.length, SKILLS.length);
  // The vectors say explain-error is closest, regardless of shared terms.
  assert.equal(ranked.skills[0].id, "explain-error");
  assert.ok(ranked.skills.every((hit) => hit.embeddingScore !== null));
});

test("hybrid at weight 0 reproduces the BM25 order", () => {
  const hybrid = rankCapabilities({
    query: "review a pull request",
    skills: SKILLS,
    tools: TOOLS,
    editedSkillIds: new Set(),
    editedToolIds: new Set(),
    options: options({ mode: "hybrid", embeddingWeight: 0 }),
    vectors: VECTORS,
  });
  assert.equal(hybrid.skills[0].id, "review-pull-request");
});

test("hybrid at weight 1 reproduces the embeddings order", () => {
  const hybrid = rankCapabilities({
    query: "review a pull request",
    skills: SKILLS,
    tools: TOOLS,
    editedSkillIds: new Set(),
    editedToolIds: new Set(),
    options: options({ mode: "hybrid", embeddingWeight: 1 }),
    vectors: VECTORS,
  });
  assert.equal(hybrid.skills[0].id, "explain-error");
});

test("hybrid hits expose both components behind the blended score", () => {
  const hybrid = rankCapabilities({
    query: "review a pull request",
    skills: SKILLS,
    tools: TOOLS,
    editedSkillIds: new Set(),
    editedToolIds: new Set(),
    options: options({ mode: "hybrid" }),
    vectors: VECTORS,
  });
  const top = hybrid.skills[0];
  assert.equal(typeof top.bm25Score, "number");
  assert.equal(typeof top.embeddingScore, "number");
});

test("a vector-backed mode without vectors fails loudly", () => {
  assert.throws(
    () =>
      rankCapabilities({
        query: "anything",
        skills: SKILLS,
        tools: TOOLS,
        editedSkillIds: new Set(),
        editedToolIds: new Set(),
        options: options({ mode: "embeddings" }),
      }),
    /requires vectors/,
  );
});

/* — The two descriptions ————————————————————————————————————————————————————— */

/**
 * The regression guard for the bug this surface was built on.
 *
 * Retrieval matches on the searchable description and hands the agent back the
 * plain one. For a long time the Playground did neither: it indexed
 * `description`, scored `description`, and returned `description`, so a project
 * that had set a searchable description was being told about a ranking no agent
 * would ever see.
 *
 * The fixture below makes the two texts share NO vocabulary on purpose. That is
 * what gives these assertions teeth: re-point ranking at `description` and the
 * first test finds nothing, while returning the matched text as the payload
 * breaks the second. A fixture where the two merely differed in wording would
 * let both mistakes through.
 */

const SPLIT_TOOL: BenchTool = {
  ...BENCH_TOOL_DEFAULTS,
  name: "calendar_create",
  // What the agent is handed. Shares no term with the retrieval text.
  description: "Persists an ICS entity to the organizer backend.",
  entryId: "calendar.create",
  // What a prompt is matched against.
  searchableDescription: "schedule a meeting, book an appointment",
  hasDefinition: true,
  calls: 5,
};

const SPLIT_SKILL: BenchSkill = {
  ...BENCH_SKILL_DEFAULTS,
  id: "s-split",
  name: "triage-incident",
  description: "Executes the runbook associated with a severity declaration.",
  searchableDescription: "page the on-call, escalate an outage",
  tags: [],
  tools: [],
  status: "published",
  version: 1,
};

test("a tool is matched on its searchable description, not the agent's copy", () => {
  const ranked = rankCapabilities({
    query: "book an appointment",
    skills: [],
    tools: [SPLIT_TOOL],
    editedSkillIds: new Set(),
    editedToolIds: new Set(),
    options: options(),
  });

  assert.deepEqual(
    ranked.tools.map((hit) => hit.id),
    ["calendar_create"],
    "the searchable description produced the match",
  );
});

test("a prompt matching only the agent description does not retrieve the tool", () => {
  // The mirror image, and the half that actually fails when someone re-points
  // ranking at `description`: without it, indexing both texts would pass.
  const ranked = rankCapabilities({
    query: "organizer backend ICS entity",
    skills: [],
    tools: [SPLIT_TOOL],
    editedSkillIds: new Set(),
    editedToolIds: new Set(),
    options: options(),
  });

  assert.deepEqual(ranked.tools, [], "the agent description is never indexed");
});

test("the payload carries the agent description, and names the matched text", () => {
  const [hit] = rankCapabilities({
    query: "schedule a meeting",
    skills: [],
    tools: [SPLIT_TOOL],
    editedSkillIds: new Set(),
    editedToolIds: new Set(),
    options: options(),
  }).tools;

  assert.equal(hit.description, SPLIT_TOOL.description, "what the agent receives");
  assert.equal(
    hit.searchableDescription,
    SPLIT_TOOL.searchableDescription,
    "what the prompt was matched against",
  );
  assert.equal(hit.searchableDescriptionSource, "runtime");
});

test("a Ratel override replaces the runtime's retrieval text for ranking", () => {
  const overridden: BenchTool = {
    ...SPLIT_TOOL,
    searchableDescriptionOverride: "reserve a conference room",
  };
  const input = {
    skills: [],
    tools: [overridden],
    editedSkillIds: new Set<string>(),
    editedToolIds: new Set<string>(),
    options: options(),
  };

  const byOverride = rankCapabilities({ ...input, query: "reserve a room" });
  assert.deepEqual(
    byOverride.tools.map((hit) => hit.id),
    ["calendar_create"],
  );
  assert.equal(byOverride.tools[0].searchableDescriptionSource, "override");
  assert.equal(
    byOverride.tools[0].description,
    SPLIT_TOOL.description,
    "an override changes what matches, never what the agent receives",
  );

  // The runtime's own text is genuinely replaced rather than added to.
  const byRuntime = rankCapabilities({ ...input, query: "book an appointment" });
  assert.deepEqual(byRuntime.tools, []);
});

test("skills honor the same split as tools", () => {
  const input = {
    skills: [SPLIT_SKILL],
    tools: [],
    editedSkillIds: new Set<string>(),
    editedToolIds: new Set<string>(),
    options: options(),
  };

  const [hit] = rankCapabilities({ ...input, query: "escalate an outage" }).skills;
  assert.equal(hit.id, "triage-incident");
  assert.equal(hit.description, SPLIT_SKILL.description);
  assert.equal(hit.searchableDescription, SPLIT_SKILL.searchableDescription);

  assert.deepEqual(
    rankCapabilities({ ...input, query: "severity declaration runbook" }).skills,
    [],
  );
});

test("capabilityIndexText embeds the retrieval text, so both scorers agree", () => {
  // BM25 and the embedding pass must read one text. Indexing different ones
  // would make a hybrid run a blend of two different readings of one tool.
  const text = capabilityIndexText(SPLIT_TOOL);
  assert.match(text, /schedule a meeting/);
  assert.doesNotMatch(text, /organizer backend/);
});
