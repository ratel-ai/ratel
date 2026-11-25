import assert from "node:assert/strict";
import { test } from "node:test";
import { type Config, resolveConfig } from "@/config";
import type { CoreFlag, FlagSubject } from "@/lib/contracts/feature-flags";
import type { FeatureFlagDeps } from "@/lib/platform/experimental-features";
import type { Organization } from "@/lib/platform/organizations";
import type { ModelReadDeps } from "@/lib/readings/trace-signals/outcomes/model-read";
import {
  type QuestionsGateDeps,
  SENTIMENT_QUESTIONS_FLAG,
  sentimentQuestionsEnabled,
} from "@/lib/readings/trace-signals/outcomes/questions-gate";
import { type OutcomeRunDeps, recordOutcomes } from "@/lib/readings/trace-signals/outcomes/run";
import { outcomeRunDeps } from "@/lib/readings/trace-signals/outcomes/run-job";

/** The questions' switch: the organization's Sentiment analysis flag, decided for a background job. */

const PROJECT = "11111111-1111-4111-8111-111111111111";
const organization = (id: string) => ({ id, slug: `org-${id}` }) as unknown as Organization;
const NOTHING_SET = resolveConfig();

interface Asked {
  key: CoreFlag;
  subject: FlagSubject;
}

/** An edition's flags port that is on for the organizations in `on`. */
function gate(
  on: ReadonlySet<string>,
  over: Partial<FeatureFlagDeps> = {},
  owner: Organization | null = organization("org_on"),
) {
  const asked: Asked[] = [];
  const deps: QuestionsGateDeps = {
    getOrganization: async () => owner,
    flags: {
      config: NOTHING_SET,
      edition: "Ratel",
      port: {
        enabled: async (key, subject) => {
          asked.push({ key, subject });
          return on.has(subject.organizationId ?? "");
        },
      },
      ...over,
    },
  };
  return { deps, asked };
}

const forced = (value: boolean): Config =>
  resolveConfig({ override: { flags: { sentimentAnalysis: value } } });

test("the questions follow sentimentAnalysis, decided per organization for the project, not a person", async () => {
  const { deps, asked } = gate(new Set(["org_on"]));
  assert.equal(SENTIMENT_QUESTIONS_FLAG, "sentimentAnalysis");
  assert.equal(await sentimentQuestionsEnabled(PROJECT, deps), true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.key, "sentimentAnalysis");
  // A background job has no signed-in person: the project is the identity and only the organization is sent.
  assert.deepEqual(asked[0]!.subject, {
    organizationId: "org_on",
    projectId: PROJECT,
    actor: `project:${PROJECT}`,
  });
});

test("an organization the flag is not on for is off", async () => {
  const { deps } = gate(new Set(["org_on"]), {}, organization("org_off"));
  assert.equal(await sentimentQuestionsEnabled(PROJECT, deps), false);
});

test("off by default: without an edition's flags port, when the decision fails, and for a project with no organization", async () => {
  assert.equal(
    await sentimentQuestionsEnabled(
      PROJECT,
      gate(new Set(["org_on"]), { edition: "Ratel OSS", port: undefined }).deps,
    ),
    false,
  );
  const failing = gate(new Set(["org_on"]), {
    port: {
      enabled: async () => {
        throw new Error("flags down");
      },
    },
  });
  assert.equal(await sentimentQuestionsEnabled(PROJECT, failing.deps), false);
  const orphan = gate(new Set(["org_on"]), {}, null);
  assert.equal(await sentimentQuestionsEnabled(PROJECT, orphan.deps), false);
  assert.equal(orphan.asked.length, 0);
});

test("a value the configuration forces turns the switch on or off, as for every flag", async () => {
  const on = gate(new Set(), { config: forced(true) });
  assert.equal(await sentimentQuestionsEnabled(PROJECT, on.deps), true);
  const off = gate(new Set(["org_on"]), { config: forced(false) });
  assert.equal(await sentimentQuestionsEnabled(PROJECT, off.deps), false);
  // Without a port the configuration is the whole decision.
  const alone = gate(new Set(), { config: forced(true), edition: "Ratel OSS", port: undefined });
  assert.equal(await sentimentQuestionsEnabled(PROJECT, alone.deps), true);
});

// ---- The reading's wiring ---------------------------------------------------

const BUDGET = { startedAt: 0, now: () => new Date(0), timeBudgetMs: 60_000 };

const modelDeps = (configured: boolean, maxAsks = 100): ModelReadDeps => ({
  ask: {
    client: configured
      ? {
          model: "closed-question-model",
          decide: async () => {
            throw new Error("not used");
          },
          decideBatch: async () => {
            throw new Error("not used");
          },
        }
      : null,
    loadVerdicts: async () => [],
    saveVerdicts: async () => undefined,
    maxAsks,
    maxTokens: 100_000,
    reasoning: "off",
  },
  loadMessages: async () => [],
  loadReplies: async () => new Map(),
  loadQueries: async () => new Map(),
});

test("the wiring: no key means no model layer and no switch to ask; a key puts the layer behind the switch", () => {
  const none = outcomeRunDeps(BUDGET, null);
  assert.deepEqual(
    [none.readModel, none.questionsSwitch, none.questionsOff],
    [undefined, undefined, "no_key"],
  );
  const unconfigured = outcomeRunDeps(BUDGET, () => modelDeps(false));
  assert.deepEqual(
    [unconfigured.readModel, unconfigured.questionsSwitch, unconfigured.questionsOff],
    [undefined, undefined, "no_key"],
  );
  const capped = outcomeRunDeps(BUDGET, () => modelDeps(true, 0));
  assert.deepEqual(
    [capped.readModel, capped.questionsSwitch, capped.questionsOff],
    [undefined, undefined, "cap_zero"],
  );
  const flag = async () => true;
  const on = outcomeRunDeps(BUDGET, () => modelDeps(true), flag);
  assert.equal(typeof on.readModel, "function");
  assert.equal(on.questionsSwitch, flag);
  assert.equal(on.questionsOff, undefined);
});

/** A reading over no turns: only what decides whether the model layer runs. */
function emptyReading(over: Partial<OutcomeRunDeps>): OutcomeRunDeps {
  return {
    listPage: async () => ({ turns: [], nextCursor: null }) as never,
    loadBasis: async () =>
      ({
        basis: "none",
        blocked: "mixed_runs",
        excludedRuns: 0,
        since: null,
        mixed: true,
      }) as never,
    loadErrors: async () => new Map(),
    replaceTurnRows: async () => ({ written: 0, sessions: [] }),
    loadSessionTurns: async () => new Map(),
    replaceSessionRows: async () => 0,
    pageSize: 100,
    ...BUDGET,
    ...over,
  };
}
const window = {
  window: { start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-09-02T00:00:00Z") },
};

test("the summary records why the questions did not run: no key, the switch off, or a switch that could not be read", async () => {
  let asked = 0;
  const readModel: OutcomeRunDeps["readModel"] = async () => null;
  const noKey = await recordOutcomes(
    PROJECT,
    window,
    emptyReading({
      questionsSwitch: async () => {
        asked += 1;
        return true;
      },
    }),
  );
  assert.equal(noKey.stored.questionsOff, "no_key");
  // Without a key the flag is not even asked.
  assert.equal(asked, 0);

  const off = await recordOutcomes(
    PROJECT,
    window,
    emptyReading({ readModel, questionsSwitch: async () => false }),
  );
  assert.equal(off.stored.questionsOff, "switch_off");

  // A switch that throws is off: asking is never the fallback.
  const broken = await recordOutcomes(
    PROJECT,
    window,
    emptyReading({
      readModel,
      questionsSwitch: async () => {
        throw new Error("flags down");
      },
    }),
  );
  assert.equal(broken.stored.questionsOff, "switch_off");

  const on = await recordOutcomes(
    PROJECT,
    window,
    emptyReading({ readModel, questionsSwitch: async () => true }),
  );
  assert.equal(on.stored.questionsOff, undefined);
});
