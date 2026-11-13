import type { StoredTopicPattern } from "@/lib/readings/topics/types";

/**
 * "Add a skill for {Intent}": an intent people ask for often, that the agent
 * works out step by step every time, with no skill in sight. A Fix source of
 * its own (the intent's numbers, read from the topics job's stored pattern);
 * its action is Copy prompt, nothing is drafted or hosted. Pure.
 *
 * Coverage is decided conservatively, from what the data can show, so a gap
 * is only raised when no skill is anywhere near the intent. An intent is
 * covered, and gets no fix, when any of these holds:
 *
 * 1. a skill ran in any of its turns (an invoke step whose target is a skill);
 * 2. a skill search offered a skill in any of its turns (a `skill_search`
 *    step that returned at least one), whether or not it ran;
 * 3. a published skill lists every one of the intent's steps among its tools
 *    (`skills.tools`, the tool ids its instructions call), in any scope.
 *
 * One skill call or offer in the whole window is enough to stay quiet. The
 * first two are read from the turns themselves, so they lag a new skill until
 * the next reading; the third is read when Fixes is, so publishing a skill
 * that names the steps clears the fix at once.
 *
 * Beyond coverage, the intent must be worth a skill: at least
 * `SKILL_GAP_MIN_TURNS` turns, and a repeated path of at least
 * `SKILL_GAP_MIN_STEPS` tools (its pattern's tools, helpers aside) that ran
 * together in at least `SKILL_GAP_MIN_RUNS` turns: steps the agent repeats,
 * worth writing down once.
 */

/** An intent needs this many turns to be worth a skill... */
export const SKILL_GAP_MIN_TURNS = 20;
/** ...a path of at least this many tools... */
export const SKILL_GAP_MIN_STEPS = 2;
/** ...run together in at least this many of its turns. */
export const SKILL_GAP_MIN_RUNS = 10;
/** Skill gaps listed at most, busiest intent first, so a project without skills sees the few that matter. */
export const SKILL_GAPS_SHOWN = 3;

/** An intent with its stored pattern and its name, as `loadTopicPatterns` reads it. */
export interface IntentGapInput {
  topicId: string;
  name: string;
  turns: number;
  pattern: StoredTopicPattern;
}

/** A published skill: its name and the tool ids its instructions call. */
export interface PublishedSkill {
  name: string;
  tools: readonly string[];
}

export interface SkillGap {
  topicId: string;
  /** The intent's name, for the title; never stored. */
  name: string;
  turns: number;
  /** The steps the skill would write down, in their usual order (catalog tool ids). */
  steps: string[];
  /** Turns that ran every step, and of those, the turns that ran them in this order. */
  runs: number;
  inOrder: number;
}

const SKILL_PREFIX = "skill:";

/** Why an intent is covered, or null when nothing covers it. */
export function skillCoverage(
  intent: Pick<IntentGapInput, "pattern">,
  skills: readonly PublishedSkill[],
): "ran" | "offered" | "published" | null {
  const { pattern } = intent;
  if (pattern.skills.invoked > 0 || pattern.tools.some((tool) => tool.id.startsWith(SKILL_PREFIX)))
    return "ran";
  if (pattern.skills.offered > 0) return "offered";
  const steps = pattern.tools.map((tool) => tool.id);
  if (steps.length > 0 && skills.some((skill) => steps.every((step) => skill.tools.includes(step))))
    return "published";
  return null;
}

/** The intents no skill covers that are worth one, busiest first, at most `max`. */
export function pickSkillGaps(
  intents: readonly IntentGapInput[],
  skills: readonly PublishedSkill[],
  opts: { max?: number } = {},
): SkillGap[] {
  return intents
    .filter((intent) => intent.turns >= SKILL_GAP_MIN_TURNS)
    .filter(
      (intent) =>
        intent.pattern.tools.length >= SKILL_GAP_MIN_STEPS &&
        intent.pattern.runs >= SKILL_GAP_MIN_RUNS,
    )
    .filter((intent) => skillCoverage(intent, skills) === null)
    .sort(
      (a, b) => b.turns - a.turns || (a.topicId < b.topicId ? -1 : a.topicId > b.topicId ? 1 : 0),
    )
    .slice(0, opts.max ?? SKILL_GAPS_SHOWN)
    .map((intent) => ({
      topicId: intent.topicId,
      name: intent.name,
      turns: intent.turns,
      steps: intent.pattern.tools.map((tool) => tool.id),
      runs: intent.pattern.runs,
      inOrder: intent.pattern.inOrder,
    }));
}
