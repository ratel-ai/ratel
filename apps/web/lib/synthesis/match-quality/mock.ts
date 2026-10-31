import { deploymentEnvironment } from "@/lib/platform/environment";
import type { JudgeCase, JudgeEngine } from "@/lib/readings/decisions/judge";
import type { AnalystDeps } from "./analyst";
import type { AnalystContext } from "./context";
import { CAPTURED_DIAGNOSIS, CAPTURED_PROPOSALS } from "./mock-fixture";

/**
 * A local stand-in for the analyst, for development only.
 *
 * Without it, opening this surface on a laptop costs a real model call every time
 * you want to look at the layout, and developing the queued -> running -> analyzed
 * transitions means paying for a run per refresh. That is the cost that stops
 * people iterating on a surface, which is how surfaces end up shipping unlooked-at.
 *
 * It REPLAYS a real answer rather than fabricating one. `mock-fixture.ts` holds a
 * verbatim `claude-sonnet-5` response to the committed Acme-shaped seed, so a
 * laptop sees text that reasons, cites sibling tools by name and runs to three
 * lines, which is what the layout actually has to survive. The previous version
 * appended the failing queries as a `| Use cases:` tail, and every proposal came
 * out the same shape and length: it exercised the plumbing and flattered the UI.
 *
 * Replaying is still not analysing. Nothing here judges anything, an entry the
 * capture never saw falls back to a template, every run made with it is stored
 * `mocked = true`, and the surface prints a chip saying so. What it must never do
 * is look like a live answer, which is why the fixture is a separate file that
 * says what it is at the top.
 *
 * Enabled by `MATCH_QUALITY_MOCK_ANALYST=1`, and refused outright anywhere that is
 * not a local environment.
 *
 * The gate reads APP_ENV, not NODE_ENV, for the same reason `embed-local.ts` does:
 * `NODE_ENV` is "production" for any `next build`, which includes `make up`, the
 * production image run on a laptop and the exact place somebody most wants this.
 *
 * The environment check is an ALLOWLIST. An unrecognized value refuses, so a
 * misconfigured or renamed environment fails closed rather than quietly serving
 * fabricated proposals to a real account.
 */

const LOCAL_ENVIRONMENTS: ReadonlySet<string> = new Set(["development", "local", "test"]);

/** Reported as the model, so nothing downstream prints a real model name. */
export const MOCK_ANALYST_MODEL = "mock-analyst-local";

/** Long enough that the queued -> running transition is actually observable. */
const DEFAULT_MOCK_DELAY_MS = 1_500;

export function mockAnalystEnabled(): boolean {
  if (!LOCAL_ENVIRONMENTS.has(deploymentEnvironment())) return false;
  return process.env.MATCH_QUALITY_MOCK_ANALYST === "1";
}

export function mockAnalystDelayMs(): number {
  const raw = Number(process.env.MATCH_QUALITY_MOCK_DELAY_MS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MOCK_DELAY_MS;
  // Capped so a typo cannot wedge a job slot for an hour.
  return Math.min(30_000, raw);
}

/**
 * The rewrite for one candidate: the captured one where the fixture has it,
 * otherwise a template in the same shape the prompt asks for.
 *
 * The fallback is deliberately shaped like the real thing ("<what it does>. Use
 * when <when>. | Use cases: <phrasings>") rather than a bare append, so a project
 * outside the fixture still exercises a realistic line length and structure. It
 * reasons about nothing, which is the honest limit of a stand-in.
 */
function rewriteFor(
  entry: { entryId: string; name: string; searchable: string },
  phrases: readonly string[],
): {
  searchableDescription: string;
  rationale: string;
  details: string;
  expectedEffect: string;
} | null {
  const captured = CAPTURED_PROPOSALS[entry.entryId];
  if (captured) return { ...captured };
  if (phrases.length === 0) return null;

  const base = entry.searchable.replace(/\s*\|\s*Use cases:.*$/i, "").trim();
  const stem = base.endsWith(".") ? base : `${base}.`;
  return {
    searchableDescription: `${stem} Use when someone asks for ${phrases[0]}. | Use cases: ${phrases.join("; ")}.`,
    rationale: "Added the wording these searches actually used.",
    details:
      `The local stand-in produced this, so there is no model reasoning behind it. ` +
      `It appends the distinct phrasings this entry was the answer for and did not win: ` +
      `${phrases.join("; ")}. Nothing was removed from the existing text.`,
    expectedEffect: "Should win those searches.",
  };
}

/** The distinct phrasings behind a candidate's losses, in first-seen order. */
function useCases(context: AnalystContext, entryId: string): string[] {
  const candidate = context.candidates.find((item) => item.entryId === entryId);
  if (!candidate) return [];
  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const failure of candidate.failures) {
    const query = failure.query?.trim();
    if (!query || seen.has(query.toLowerCase())) continue;
    seen.add(query.toLowerCase());
    phrases.push(query);
    if (phrases.length >= 4) break;
  }
  return phrases;
}

/**
 * Deterministic mock deps.
 *
 * The prompt arguments are ignored, but they are still BUILT: `analyse()` calls
 * `buildAnalystPrompt` before it calls `complete`, so a mocked run still exercises
 * the real assembly path and a context that would break the prompt still breaks
 * here rather than only in production.
 */
export function mockAnalystDeps(
  context: AnalystContext,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): AnalystDeps {
  return {
    model: MOCK_ANALYST_MODEL,
    complete: async (system, user) => {
      void system;
      void user;
      await sleep(mockAnalystDelayMs());

      const proposals = context.candidates
        .map((candidate) => {
          const entry = context.corpus.find((row) => row.entryId === candidate.entryId);
          if (!entry) return null;
          const rewrite = rewriteFor(entry, useCases(context, candidate.entryId));
          // No "mocked locally" preamble on any field. The run carries `mocked`
          // and the surface prints one chip for it, so repeating the caveat per
          // proposal spent a line of every card restating a fact about the page.
          return rewrite === null ? null : { entryId: candidate.entryId, ...rewrite };
        })
        .filter((proposal): proposal is NonNullable<typeof proposal> => proposal !== null);

      // The captured diagnosis only makes sense next to captured proposals; a run
      // that fell back to templates throughout has no read to offer, and the
      // honest way to say that is an empty slot rather than prose explaining it.
      const replayed = proposals.some((proposal) => proposal.entryId in CAPTURED_PROPOSALS);
      return JSON.stringify({
        diagnosis: replayed
          ? { headline: CAPTURED_DIAGNOSIS, points: [] }
          : { headline: "", points: [] },
        proposals,
      });
    },
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A local stand-in for the judge.
 *
 * It answers on a fixed rotation rather than on the merits: one case in four is
 * declined, one in four is answered with a different catalog entry, and the rest
 * agree with what the reference tier already assumed. Nothing here reads a query
 * or a description.
 *
 * The rotation exists because all three outcomes have to be visible on a laptop.
 * An earlier version agreed with everything, which is more obviously not a
 * judgment but left the judge tier invisible: no row ever carried the judged
 * glyph, and the calibration figure was a flat 100% that exercised none of the
 * arithmetic under it. A stand-in that cannot reach the states the UI has to
 * render is not doing its job.
 *
 * So the calibration number this produces is a property of the rotation, not a
 * measurement of anything. The run carries `mocked` and the surface prints a chip
 * for it, which is the same guard every other mocked figure on the page relies on.
 */
export function mockJudgeEngine(sleep: (ms: number) => Promise<void> = defaultSleep): JudgeEngine {
  return {
    model: MOCK_ANALYST_MODEL,
    judge: async (cases, corpus) => {
      await sleep(Math.min(400, mockAnalystDelayMs()));
      const corpusIds = corpus.map((entry) => entry.entryId);
      return cases.map((row, index) => {
        if (index % 4 === 0) return { id: row.id, entryId: "", confident: false };
        if (index % 4 === 1) {
          return { id: row.id, entryId: otherEntry(row, corpusIds, index), confident: true };
        }
        return { id: row.id, entryId: row.assumed, confident: true };
      });
    },
  };
}

/**
 * Some catalog entry that is not the one the reference tier assumed.
 *
 * Prefers the case's own shortlist, because a real judge usually picks something
 * one of the engines returned, and falls back to the corpus so a disagreement is
 * still reachable on a fixture whose telemetry names entries the catalog never
 * ingested. Returns "" when the corpus offers no alternative, which
 * `validateVerdicts` reads as an abstention.
 */
function otherEntry(
  row: Pick<JudgeCase, "assumed" | "shortlist">,
  corpusIds: readonly string[],
  seed: number,
): string {
  const inCorpus = new Set(corpusIds);
  const fromShortlist = row.shortlist.find(
    (entryId) => entryId !== row.assumed && inCorpus.has(entryId),
  );
  if (fromShortlist) return fromShortlist;
  const alternatives = corpusIds.filter((entryId) => entryId !== row.assumed);
  return alternatives[seed % Math.max(1, alternatives.length)] ?? "";
}
