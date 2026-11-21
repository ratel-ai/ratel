import type { OperationContext } from "@/lib/mcp/registry";
import { apiKeyPolicy } from "@/lib/platform/api-keys/policy";
import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { getLogger } from "@/lib/platform/logger";
import { contentOptIn } from "@/lib/views/session-replay/runs";

/**
 * Who may read captured end-user text over MCP: asks, answers, messages,
 * search queries, tool arguments and results, SDK payloads, the agent's own
 * phrases.
 *
 * An OAuth caller is a signed-in member, and reads it as the console shows it
 * to them. An API key is an `rtl_` ingest key that lives in the customer's
 * runtime, so it reads it only once the project has turned content reading on
 * (`contentOptIn`, the session replay setting in project Settings). Every tool
 * that returns such text asks here, so the rule lives in one place.
 *
 * A withheld result keeps everything else (names, timing, counts, status),
 * leaves the text out or null and says so with `contentWithheld: true` and
 * `CONTENT_WITHHELD_HINT`.
 */

const logger = getLogger("mcp/content-access");

export interface ContentAccessDeps {
  /** The project's content opt-in, as Settings stores it. */
  contentOptIn: (projectId: string) => Promise<boolean>;
}

export const CONTENT_WITHHELD_HINT =
  "Captured text is shown to signed-in members, or to API keys with the content permission once content reading is turned on in project Settings.";

/** The opt-in read under the short supplementary timeout: it gates text, it is never the answer. */
export function readContentOptIn(projectId: string): Promise<boolean> {
  return withStatementTimeout((db) => contentOptIn(projectId, db), {
    operation: "mcp_content_opt_in",
    timeoutMs: supplementaryReadTimeoutMs(),
  });
}

export const defaultContentAccessDeps: ContentAccessDeps = { contentOptIn: readContentOptIn };

/**
 * The credential half of the rule (RC-585): a signed-in member always passes,
 * an API key only with its own `content:read` scope, so a read-only key never
 * sees end-user text unless it was given that too. A tool with its own
 * opt-in rule (the session page's, in `ship.ts`) still asks this first.
 */
export function credentialMayReadContent(auth: OperationContext["auth"]): boolean {
  return auth.kind === "oauth" || apiKeyPolicy(auth.scopes).allows("content:read");
}

/**
 * Whether this caller may read captured text in this project. A failed opt-in
 * read is logged and withholds the text: the call still answers, without it.
 */
export async function mayReadContent(
  ctx: Pick<OperationContext, "auth" | "projectId">,
  deps: ContentAccessDeps,
): Promise<boolean> {
  if (ctx.auth.kind === "oauth") return true;
  if (!credentialMayReadContent(ctx.auth)) return false;
  try {
    return await deps.contentOptIn(ctx.projectId);
  } catch (err) {
    logger.error(
      { err, project_id: ctx.projectId },
      "content opt-in read failed; captured text withheld",
    );
    return false;
  }
}

/** The experiment attribute carrying the search an end user ran (`selection-view.ts` reads it). */
export const EXPERIMENT_QUERY_ATTRIBUTE = "ratel.experiment.query";

/** Experiment attributes as a caller may read them: the query left out when text is withheld. */
export function experimentAttributesFor(
  attributes: Readonly<Record<string, unknown>>,
  content: boolean,
): Readonly<Record<string, unknown>> {
  if (content || !(EXPERIMENT_QUERY_ATTRIBUTE in attributes)) return attributes;
  return Object.fromEntries(
    Object.entries(attributes).filter(([key]) => key !== EXPERIMENT_QUERY_ATTRIBUTE),
  );
}

/** The marker a withheld result carries; nothing when the text was returned. */
export function withheldMarker(content: boolean): { contentWithheld?: true } {
  return content ? {} : { contentWithheld: true };
}

/** A hint that leads with why text is missing when it was withheld. */
export function contentHint(content: boolean, hint: string | undefined): string | undefined {
  if (content) return hint;
  return hint ? `${CONTENT_WITHHELD_HINT} ${hint}` : CONTENT_WITHHELD_HINT;
}
