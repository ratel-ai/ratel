import { createHash } from "node:crypto";
import type {
  CorpusEntry,
  JudgeCase,
  JudgeEngine,
  JudgeVerdict,
} from "@/lib/readings/decisions/judge";
import { AUDIT_SAMPLE, auditVerdict, spreadPick } from "./adaptive";

/**
 * Decisions that survive a change of options (RC-395).
 *
 * Topic placement and workflow decisions are cached by a hash of the WHOLE
 * option list, so one new or renamed topic or task re-asked every ask (up to
 * the job's cap) on every reading. Here a stored decision for an ask is
 * carried to the new list when the option it chose is still on it,
 * unchanged (`optionPrint`). A carried decision can still be wrong: a new
 * option might fit the ask better. So each pass re-asks a sample of the
 * carried ones (the audit); when too few come back the same, none of the
 * carried decisions stand and the asks are put to the engine again, within
 * the same budget.
 *
 * Everything decided here (fresh, or carried and kept) is written under the
 * current option list, so the next pass over the same list is an exact hit.
 */

/** A stored decision that may be carried: the option it chose and that option's print then. */
export interface CarriedRow {
  promptHash: string;
  optionId: string;
  optionPrint: string;
}

/** The fingerprint of one option as the engine saw it: what the decision is about. */
export function optionPrint(
  family: string,
  option: Pick<CorpusEntry, "entryId" | "name" | "description">,
): string {
  return createHash("sha256")
    .update([family, option.entryId, option.name, option.description ?? ""].join("\u0000"))
    .digest("hex")
    .slice(0, 24);
}

export interface CarryOutcome {
  /** Each decided case id: the option id it is placed in (fresh, exact or carried). */
  choices: Map<string, string>;
  /** Verdicts the engine returned this pass (to store, with their prints). */
  fresh: JudgeVerdict[];
  /** Cases put to the engine this pass, answered or not: what the caller's budget pays for. */
  asked: number;
  /** Decisions carried from an earlier option list and kept. */
  carried: Map<string, string>;
  audited: number;
  auditAgreed: number;
  audit: "trust" | "distrust" | "unknown";
}

/**
 * Decide `cases` against `options`: cached answers for this exact list are
 * free (`exact`), carried ones are checked by the audit, and the engine is
 * asked about the rest, at most `budget` fresh calls in all (the audit
 * included). Cases are taken in the order given (busiest first, by the
 * callers). An engine that throws throws: the callers already log, report
 * and fall back.
 */
export async function decideWithCarry(input: {
  family: string;
  cases: readonly JudgeCase[];
  options: readonly CorpusEntry[];
  exact: ReadonlyMap<string, { entryId: string }>;
  previous: readonly CarriedRow[];
  judge: JudgeEngine;
  budget: number;
  auditSample?: number;
}): Promise<CarryOutcome> {
  const byId = new Map(input.options.map((option) => [option.entryId, option]));
  const choices = new Map<string, string>();
  for (const row of input.cases) {
    const hit = input.exact.get(row.id);
    if (hit && hit.entryId !== "") choices.set(row.id, hit.entryId);
  }
  const missing = input.cases.filter((row) => !input.exact.has(row.id));

  // The newest stored decision per ask whose option is still here, unchanged.
  const carriable = new Map<string, string>();
  for (const row of input.previous) {
    if (carriable.has(row.promptHash)) continue;
    const option = byId.get(row.optionId);
    if (option && optionPrint(input.family, option) === row.optionPrint)
      carriable.set(row.promptHash, row.optionId);
  }
  const carriedCases = missing.filter((row) => carriable.has(row.id));
  const open = missing.filter((row) => !carriable.has(row.id));

  let budget = Math.max(0, Math.floor(input.budget));
  const auditCases = spreadPick(carriedCases, Math.min(budget, input.auditSample ?? AUDIT_SAMPLE));
  const firstAsk = [...auditCases, ...open.slice(0, Math.max(0, budget - auditCases.length))];
  const fresh: JudgeVerdict[] =
    firstAsk.length > 0 ? await input.judge.judge(firstAsk, input.options) : [];
  budget -= firstAsk.length;
  let asked = firstAsk.length;

  const answered = new Map(fresh.map((verdict) => [verdict.id, verdict.entryId]));
  let audited = 0;
  let auditAgreed = 0;
  for (const row of auditCases) {
    const now = answered.get(row.id);
    if (now === undefined) continue;
    audited += 1;
    if (now === carriable.get(row.id)) auditAgreed += 1;
  }
  const audit = auditVerdict(auditAgreed, audited);

  const carried = new Map<string, string>();
  if (audit === "distrust") {
    // The carry is not safe for this change of options: ask again, within the budget left.
    const auditedIds = new Set(auditCases.map((row) => row.id));
    const retry = carriedCases
      .filter((row) => !auditedIds.has(row.id))
      .slice(0, Math.max(0, budget));
    if (retry.length > 0) {
      asked += retry.length;
      const again = await input.judge.judge(retry, input.options);
      fresh.push(...again);
      for (const verdict of again) answered.set(verdict.id, verdict.entryId);
    }
  } else {
    for (const row of carriedCases) {
      if (answered.has(row.id)) continue;
      const optionId = carriable.get(row.id);
      if (optionId) carried.set(row.id, optionId);
    }
  }
  for (const [id, entryId] of answered) if (entryId !== "") choices.set(id, entryId);
  for (const [id, optionId] of carried) choices.set(id, optionId);
  return { choices, fresh, asked, carried, audited, auditAgreed, audit };
}
