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
  approvalProblem,
  type CaseContent,
  type CaseDetails,
  caseContentSchema,
  caseDetailsSchema,
  draftVersion,
  MAX_CONTENT_CHARS,
} from "./domain/case";
import { caseFromTurn, type TurnContent } from "./domain/from-turn";
import type { CaseStore } from "./ports/case-store";

/**
 * The session routes of cases: create (from a turn or from nothing), edit and approve. An edit
 * writes the draft, or makes a new one. No route changes an approved version.
 */
export type CasesApiDeps = MemberAccessDeps & {
  cases: () => CaseStore;
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
  | { name: "eval_case_approved" };

/** The JSON of a request may be a little larger than the content in it. */
const MAX_BODY_CHARS = MAX_CONTENT_CHARS * 2;
const fromTurnSchema = z.object({ turnId: z.uuid() });
const editSchema = caseDetailsSchema.extend({ content: caseContentSchema });
const tokenSchema = z.object({ versionId: z.uuid(), updatedAt: z.iso.datetime() });
const changeSchema = editSchema.extend({ base: tokenSchema });

export function handleCreateCase(
  request: Request,
  projectId: string,
  deps: CasesApiDeps,
): Promise<Response> {
  return write(projectId, "create_case", deps, async (member) => {
    const body = await readJson(request);
    const turn = fromTurnSchema.safeParse(body);
    if (turn.success) return createFromTurn(turn.data.turnId, member, deps);
    const edit = editSchema.safeParse(body);
    if (!edit.success) return invalid(edit.error);
    return create(edit.data, { source: "blank" }, member, deps);
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
    const token = { versionId: base.versionId, updatedAt: new Date(base.updatedAt) };
    const saved = await deps.cases().saveDraft(member.projectId, caseId, change, token, deps.now());
    if (saved === "not_found") return notFound();
    if (saved === "changed") return changed();
    return reply(200, { caseId, draft: draftView(saved) });
  });
}

export function handleApproveCase(
  request: Request,
  projectId: string,
  caseId: string,
  deps: CasesApiDeps,
): Promise<Response> {
  return write(projectId, "approve_case", deps, async (member) => {
    const body = tokenSchema.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error);
    const evalCase = isId(caseId) ? await deps.cases().get(member.projectId, caseId) : null;
    if (!evalCase) return notFound();
    const draft = draftVersion(evalCase);
    if (!draft || draft.id !== body.data.versionId) return changed();
    const problem = approvalProblem(draft);
    if (problem) return refuse(422, "not_ready", problem);
    const result = await deps
      .cases()
      .approve(
        member.projectId,
        caseId,
        { versionId: draft.id, updatedAt: new Date(body.data.updatedAt) },
        { userId: member.externalId, now: deps.now() },
      );
    if (result === "not_found") return notFound();
    if (result === "changed") return changed();
    await deps.track({ name: "eval_case_approved" }, member);
    return reply(200, { caseId, versionId: draft.id, number: draft.number, state: "approved" });
  });
}

async function createFromTurn(
  turnId: string,
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
    { source: "turn", turnId, output: made.sourceOutput },
    member,
    deps,
  );
}

async function create(
  edit: CaseDetails & { content: CaseContent },
  origin: { source: "blank" } | { source: "turn"; turnId: string; output: string | null },
  member: Member,
  deps: CasesApiDeps,
): Promise<Response> {
  const created = await deps.cases().create({
    ...edit,
    projectId: member.projectId,
    createdBy: member.externalId,
    ...(origin.source === "turn"
      ? { source: { turnId: origin.turnId, output: origin.output } }
      : {}),
  });
  await deps.track({ name: "eval_case_created", source: origin.source }, member);
  return reply(201, { caseId: created.id, draft: draftView(created) });
}

function write(
  projectId: string,
  operation: string,
  deps: CasesApiDeps,
  work: (member: Member) => Promise<Response>,
): Promise<Response> {
  return forMember(projectId, { feature: "evals", operation }, deps, work, { write: true });
}

function draftView(evalCase: Parameters<typeof draftVersion>[0]) {
  const draft = draftVersion(evalCase);
  return draft
    ? { versionId: draft.id, number: draft.number, updatedAt: draft.updatedAt.toISOString() }
    : null;
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
