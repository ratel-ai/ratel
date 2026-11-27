import { z } from "zod";
import {
  forMember,
  type Member,
  type MemberAccessDeps,
  refuse,
  reply,
} from "@/lib/console/scope/member-access";
import { storable } from "@/lib/platform/storable";
import {
  type CaseContent,
  type CaseDetails,
  caseContentSchema,
  caseDetailsSchema,
  currentVersion,
  type EvalCase,
  inputProblem,
  MAX_CONTENT_CHARS,
} from "./domain/case";
import { evalContentSchema, evalDetailsSchema } from "./domain/eval";
import { caseFromTurn, type TurnContent } from "./domain/from-turn";
import type { CaseStore } from "./ports/case-store";
import type { EvalStore } from "./ports/eval-store";
import type { TaskLinks } from "./ports/task-links";
import { saveOptions } from "./save-target";

/**
 * The session routes of cases: create (from a turn or from nothing) in the datasets of one or more
 * evals, and edit. A row counts at once. An edit adds a version, and the newest counts. No route
 * changes a version (decision `rows-count-at-once`).
 */
export type CasesApiDeps = MemberAccessDeps & {
  cases: () => CaseStore;
  evals: () => EvalStore;
  taskLinks: () => TaskLinks;
  /** Whether the project lets the product read captured text. */
  readContent: (projectId: string) => Promise<boolean>;
  loadTurn: (projectId: string, turnId: string) => Promise<TurnContent | null>;
  /** The tools that the project's sandboxes declare with no side effects. */
  readOnlyTools: (projectId: string) => Promise<ReadonlySet<string>>;
  track: (event: CaseEvent, member: Member) => Promise<void>;
  now: () => Date;
};

export type CaseEvent =
  | { name: "eval_case_created"; source: "turn" | "blank" }
  | { name: "eval_created"; source: "save_case" };

/** The JSON of a request may be a little larger than the content in it. */
const MAX_BODY_CHARS = MAX_CONTENT_CHARS * 2;
/** A turn of more tasks becomes one row in the eval of each task that the person chose. */
const MAX_TARGETS = 20;
/** The eval of a new case: one that exists, or a new one that the person confirmed. */
const targetSchema = z.union([
  z.object({ evalId: z.uuid() }),
  z.object({
    newEval: evalDetailsSchema.extend({
      content: evalContentSchema.default(evalContentSchema.parse({})),
    }),
  }),
]);
type Target = z.infer<typeof targetSchema>;
/** The evals of the new case: a list, or one eval. */
const targetsSchema = z.union([
  z.object({ targets: z.array(targetSchema).min(1).max(MAX_TARGETS) }),
  targetSchema.transform((target) => ({ targets: [target] })),
]);
const fromTurnSchema = z.object({ turnId: z.uuid() });
const editSchema = caseDetailsSchema.extend({ content: caseContentSchema });
const optionsSchema = z.object({
  turnId: z.uuid().optional(),
  traceId: z.string().trim().min(1).max(200).optional(),
  task: z.string().trim().min(1).max(200).optional(),
});
const tokenSchema = z.object({ versionId: z.uuid() });
const changeSchema = editSchema.extend({ base: tokenSchema });

export function handleCreateCase(
  request: Request,
  projectId: string,
  deps: CasesApiDeps,
): Promise<Response> {
  return write(projectId, "create_case", deps, async (member) => {
    const body = await readJson(request);
    const chosen = targetsSchema.safeParse(body);
    if (!chosen.success) {
      return refuse(400, "invalid", "Choose the evals of the case: evalId, newEval or targets.");
    }
    const { targets } = chosen.data;
    const turn = fromTurnSchema.safeParse(body);
    if (turn.success) return createFromTurn(turn.data.turnId, targets, member, deps);
    const edit = editSchema.safeParse(body);
    if (!edit.success) return invalid(edit.error);
    return create(edit.data, targets, { source: "blank" }, member, deps);
  });
}

export function handleEditCase(
  request: Request,
  projectId: string,
  caseId: string,
  deps: CasesApiDeps,
): Promise<Response> {
  return write(projectId, "edit_case", deps, async (member) => {
    const edit = changeSchema.safeParse(await readJson(request));
    if (!edit.success) return invalid(edit.error);
    if (!isId(caseId)) return notFound();
    const { base, ...change } = edit.data;
    const problem = inputProblem(change.content);
    if (problem) return refuse(422, "no_input", problem);
    const saved = await deps.cases().update(member.projectId, caseId, change, base, deps.now());
    if (saved === "not_found") return notFound();
    if (saved === "changed") return changed();
    return reply(200, rowView(saved));
  });
}

/**
 * What the "Save as eval case" dialog shows first: the tasks of the turn or of the trace of a run,
 * the default task, and the target eval of each task.
 */
export function handleSaveOptions(
  request: Request,
  projectId: string,
  deps: CasesApiDeps,
): Promise<Response> {
  const span = { feature: "evals", operation: "save_case_options" } as const;
  return forMember(projectId, span, deps, async (member) => {
    const query = Object.fromEntries(new URL(request.url).searchParams);
    const parsed = optionsSchema.safeParse(query);
    if (!parsed.success) return invalid(parsed.error);
    const { turnId, traceId, task } = parsed.data;
    const source = turnId ? { turnId } : traceId ? { traceId } : null;
    const options = await saveOptions(member.projectId, source, task ?? null, {
      taskLinks: deps.taskLinks(),
      evals: deps.evals(),
    });
    return reply(200, options);
  });
}

async function createFromTurn(
  turnId: string,
  targets: readonly Target[],
  member: Member,
  deps: CasesApiDeps,
): Promise<Response> {
  if (!(await deps.readContent(member.projectId))) {
    return refuse(
      403,
      "no_content_access",
      "This project does not let Ratel read captured text. An admin can change it in Settings.",
    );
  }
  const turn = await deps.loadTurn(member.projectId, turnId);
  if (!turn) return notFound();
  const made = caseFromTurn(turn, await deps.readOnlyTools(member.projectId));
  if (!made) return refuse(422, "no_input", "This turn has no captured input.");
  const content = caseContentSchema.safeParse(made.content);
  if (!content.success) return invalid(content.error);
  return create(
    { name: made.name, labels: [], content: content.data },
    targets,
    { source: "turn", turnId, output: made.sourceOutput },
    member,
    deps,
  );
}

/** One row in each eval of the targets, in one transaction. The same eval twice is one row. */
async function create(
  edit: CaseDetails & { content: CaseContent },
  targets: readonly Target[],
  origin: { source: "blank" } | { source: "turn"; turnId: string; output: string | null },
  member: Member,
  deps: CasesApiDeps,
): Promise<Response> {
  const problem = inputProblem(edit.content);
  if (problem) return refuse(422, "no_input", problem);
  const evalIds: string[] = [];
  for (const target of targets) {
    const evalId = await evalOf(target, member, deps);
    if (!evalId) return refuse(404, "not_found", "There is no such eval.");
    if (!evalIds.includes(evalId)) evalIds.push(evalId);
  }
  const created = await deps.cases().createAll(
    evalIds.map((evalId) => ({
      ...edit,
      evalId,
      projectId: member.projectId,
      createdBy: member.externalId,
      ...(origin.source === "turn"
        ? { source: { turnId: origin.turnId, output: origin.output } }
        : {}),
    })),
  );
  if (created === "eval_not_found") return refuse(404, "not_found", "There is no such eval.");
  await Promise.all(
    created.map(() => deps.track({ name: "eval_case_created", source: origin.source }, member)),
  );
  return reply(201, { cases: created.map(rowView) });
}

/**
 * The id of the eval of the case. A new eval with the name of an eval that exists is that eval:
 * the person chose the name, and two saves at the same time make one eval.
 */
async function evalOf(target: Target, member: Member, deps: CasesApiDeps): Promise<string | null> {
  if ("evalId" in target) return target.evalId;
  const evals = deps.evals();
  const { name, taskId, content } = target.newEval;
  const found = await evals.getByName(member.projectId, name);
  if (found) return found.id;
  const made = await evals.create({
    projectId: member.projectId,
    name,
    taskId,
    content,
    createdBy: member.externalId,
  });
  if (made !== "name_taken") {
    await deps.track({ name: "eval_created", source: "save_case" }, member);
    return made.id;
  }
  return (await evals.getByName(member.projectId, name))?.id ?? null;
}

function write(
  projectId: string,
  operation: string,
  deps: CasesApiDeps,
  work: (member: Member) => Promise<Response>,
): Promise<Response> {
  return forMember(projectId, { feature: "evals", operation }, deps, work, { write: true });
}

/** A row and its version that counts: the base of the next edit. */
function rowView(evalCase: EvalCase) {
  const version = currentVersion(evalCase);
  return {
    caseId: evalCase.id,
    evalId: evalCase.evalId,
    versionId: version?.id ?? null,
    number: version?.number ?? null,
  };
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text().catch(() => "");
  if (text.length > MAX_BODY_CHARS) return null;
  try {
    const value: unknown = JSON.parse(text);
    // Before the checks: a name of NUL only is empty. It also throws when the JSON is too deep.
    return value === null ? null : storable(value);
  } catch {
    return null;
  }
}

function invalid(error: z.ZodError): Response {
  const issue = error.issues[0];
  const where = issue?.path.join(".");
  return refuse(400, "invalid", `${where ? `${where}: ` : ""}${issue?.message ?? "Invalid."}`);
}

function isId(id: string): boolean {
  return z.uuid().safeParse(id).success;
}

function notFound(): Response {
  return refuse(404, "not_found", "Not found.");
}

function changed(): Response {
  return refuse(409, "changed", "Another person changed this case. Read it again.");
}
