/**
 * Every URL the task pages make or answer, in one place. Tasks live under
 * Agent health; their neighbours (Intents, Self-corrections, Fixes, Quality ›
 * Descriptions, Catalog) are linked by the query parameters their own pages
 * read.
 */

const root = (projectId: string): string => `/project/${encodeURIComponent(projectId)}`;

function withQuery(path: string, params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export function agentHealthHref(projectId: string): string {
  return `${root(projectId)}/health`;
}

export function tasksHref(projectId: string, opts: { peek?: string | null } = {}): string {
  return withQuery(`${root(projectId)}/health/tasks`, { peek: opts.peek });
}

export function taskHref(projectId: string, taskId: string): string {
  return `${root(projectId)}/health/tasks/${encodeURIComponent(taskId)}`;
}

/** A task's page with a panel open: one of its steps (`step:<toolId>`) or one of its issues (`issue:<id>`). */
export function taskPeekHref(projectId: string, taskId: string, peek: string): string {
  return withQuery(taskHref(projectId, taskId), { peek });
}

const STEP_PEEK = "step:";
const ISSUE_PEEK = "issue:";

export function stepPeek(toolId: string): string {
  return `${STEP_PEEK}${toolId}`;
}

export function issuePeek(issueId: string): string {
  return `${ISSUE_PEEK}${issueId}`;
}

/** What a task page's `?peek=` opens: a step, an issue, or nothing it knows. */
export function parseTaskPeek(
  peek: string | null | undefined,
): { kind: "step" | "issue"; id: string } | null {
  if (!peek) return null;
  if (peek.startsWith(STEP_PEEK) && peek.length > STEP_PEEK.length)
    return { kind: "step", id: peek.slice(STEP_PEEK.length) };
  if (peek.startsWith(ISSUE_PEEK) && peek.length > ISSUE_PEEK.length)
    return { kind: "issue", id: peek.slice(ISSUE_PEEK.length) };
  return null;
}

/** An issue open in its panel on Agent health's Summary, with its example turns. */
export function healthIssueHref(projectId: string, issueId: string): string {
  return withQuery(agentHealthHref(projectId), { peek: issuePeek(issueId) });
}

/** Quality › Descriptions, where a searchable description is updated: open on a tool, or on a drafted rewrite (`rewrite:<id>`). */
export function descriptionsHref(
  projectId: string,
  opts: { tool?: string | null; peek?: string | null },
): string {
  return withQuery(
    `${root(projectId)}/quality/descriptions`,
    opts.peek ? { peek: opts.peek } : { tool: opts.tool },
  );
}

/** A tool (or a skill, `skill:<id>`) on Catalog. */
export function catalogToolHref(projectId: string, toolId: string): string {
  if (toolId.startsWith("skill:"))
    return withQuery(`${root(projectId)}/catalogs/skills`, {
      skill: toolId.slice("skill:".length),
    });
  return withQuery(`${root(projectId)}/catalogs/tools`, { q: toolId, highlight: toolId });
}

/** One session turn by turn, with the tools to mark (`?tools=a,b`, at most eight). */
export function taskSessionHref(
  projectId: string,
  sessionId: string,
  opts: { tools?: readonly string[]; task?: string | null } = {},
): string {
  const tools = (opts.tools ?? []).slice(0, 8);
  return withQuery(`${root(projectId)}/health/tasks/sessions/${encodeURIComponent(sessionId)}`, {
    tools: tools.length > 0 ? tools.join(",") : null,
    task: opts.task,
  });
}

export function selfCorrectionsHref(
  projectId: string,
  filter: { task?: string; tool?: string; topic?: string } = {},
): string {
  return withQuery(`${root(projectId)}/health/self-corrections`, filter);
}

/** The Fixes list, filtered to a task, a tool or a topic, or open on one fix. */
export function fixesHref(
  projectId: string,
  filter: { task?: string; tool?: string; topic?: string; peek?: string } = {},
): string {
  return withQuery(`${root(projectId)}/improvement/fixes`, filter);
}

export function topicHref(projectId: string, topicId: string): string {
  return withQuery(`${root(projectId)}/intents`, { peek: topicId });
}

export const UNSERVED_PEEK = "unserved";

type Query = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined): string | null => {
  const one = Array.isArray(value) ? value[0] : value;
  return typeof one === "string" && one.length > 0 ? one : null;
};

/** An ask id from a Tool craft link (`?ask=`, or `?peek=` on its Asks tab); null when absent or malformed. */
export function legacyAskId(query: Query): string | null {
  const id = first(query.ask) ?? first(query.peek);
  return id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

/**
 * Where an old Tool craft link lands now. Its Asks became Tasks: an open ask
 * goes to the task its tools run as when one is found (`taskOfAsk`), else the
 * list. Its suggestions became Fixes (`?view=crafts`).
 */
export function legacyToolCraftTarget(
  projectId: string,
  query: Query,
  taskOfAsk: string | null,
): string {
  if (first(query.view) === "crafts") return fixesHref(projectId);
  if (legacyAskId(query) && taskOfAsk) return taskHref(projectId, taskOfAsk);
  return tasksHref(projectId);
}
