import { z } from "zod";
import { getLogger } from "@/lib/platform/logger";
import type { Organization } from "@/lib/platform/organizations";
import type { Project } from "@/lib/platform/projects/schema";
import { parseSelector, SelectorError, type UseCase, UseCaseNameSchema } from "./domain/use-case";
import type { UseCaseRejection, UseCaseStore } from "./ports/store";

/**
 * `/api/projects/<id>/fine-tuning/use-cases[/<useCaseId>]` (RC-1124): list,
 * create, update and archive a project's use cases. Any member of the
 * project's organization may; a support session only reads. Behind
 * `FF_FINE_TUNING`: off, the routes are not found. Store errors propagate
 * to `withRequestLog()`.
 */

export type UseCaseEvent = {
  name: "use_case_created" | "use_case_updated" | "use_case_archived";
  externalId: string;
  projectId: string;
  organizationId: string;
  useCase: UseCase;
};

export interface UseCaseApiDeps {
  getSession: () => Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope: (
    projectId: string,
    userId: string,
  ) => Promise<{ project: Project; organization: Organization; role: string } | null>;
  fineTuningEnabled: (organization: Organization) => Promise<boolean>;
  isRestricted: () => Promise<boolean>;
  store: () => UseCaseStore;
  track: (event: UseCaseEvent) => Promise<void>;
}

export const USE_CASE_REJECTIONS: Record<UseCaseRejection, { status: number; message: string }> = {
  name_taken: { status: 409, message: "A use case of this project already has that name." },
  not_found: { status: 404, message: "This project has no use case with that ID." },
};

const logger = getLogger("fine-tuning/use-cases-api");
const CreateBody = z.object({ name: UseCaseNameSchema, selector: z.unknown() }).strict();
const UpdateBody = z
  .object({ name: UseCaseNameSchema.optional(), selector: z.unknown().optional() })
  .strict()
  .refine((body) => body.name !== undefined || body.selector !== undefined, {
    message: "Change the name or the selector.",
  });

/** `GET` lists, `POST` creates. */
export async function handleUseCasesRequest(
  request: Request,
  projectId: string,
  deps: UseCaseApiDeps,
): Promise<Response> {
  const scope = await authorize(request, projectId, deps);
  if (scope instanceof Response) return scope;
  const store = deps.store();
  if (request.method === "GET")
    return json(200, {
      ok: true,
      useCases: (await store.listUseCases(scope.project.id)).map(viewOfUseCase),
    });

  const parsed = CreateBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return invalid(parsed.error);
  const selector = selectorOrResponse(parsed.data.selector);
  if (selector instanceof Response) return selector;
  const result = await store.createUseCase(
    scope.project.id,
    { name: parsed.data.name, selector },
    scope.externalId,
  );
  return written(result, "use_case_created", scope, deps, 201);
}

/** `GET` reads one, `PATCH` updates it, `DELETE` archives it. */
export async function handleUseCaseRequest(
  request: Request,
  projectId: string,
  useCaseId: string,
  deps: UseCaseApiDeps,
): Promise<Response> {
  const scope = await authorize(request, projectId, deps);
  if (scope instanceof Response) return scope;
  const store = deps.store();
  if (request.method === "GET") {
    const useCase = await store.getUseCase(scope.project.id, useCaseId);
    return useCase
      ? json(200, { ok: true, useCase: viewOfUseCase(useCase) })
      : rejection("not_found");
  }
  if (request.method === "DELETE")
    return written(
      await store.archiveUseCase(scope.project.id, useCaseId),
      "use_case_archived",
      scope,
      deps,
      200,
    );

  const parsed = UpdateBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return invalid(parsed.error);
  const selector =
    parsed.data.selector === undefined ? undefined : selectorOrResponse(parsed.data.selector);
  if (selector instanceof Response) return selector;
  const result = await store.updateUseCase(scope.project.id, useCaseId, {
    name: parsed.data.name,
    selector,
  });
  return written(result, "use_case_updated", scope, deps, 200);
}

/** What a page, a route and a tool show of a use case. */
export function viewOfUseCase(useCase: UseCase) {
  return {
    id: useCase.id,
    name: useCase.name,
    selector: useCase.selector,
    createdBy: useCase.createdBy,
    createdAt: useCase.createdAt.toISOString(),
  };
}

type Scope = { project: Project; organization: Organization; externalId: string };

async function authorize(
  request: Request,
  projectId: string,
  deps: UseCaseApiDeps,
): Promise<Scope | Response> {
  const session = await deps.getSession();
  if (!session)
    return json(401, { ok: false, error: "signed_out", message: "Sign in to see use cases." });
  const scope = await deps.findProjectScope(projectId, session.user.id);
  if (!scope || !(await deps.fineTuningEnabled(scope.organization))) {
    return json(404, {
      ok: false,
      error: "not_found",
      message: "No project you belong to has that ID.",
    });
  }
  if (request.method !== "GET" && (await deps.isRestricted())) {
    return json(403, {
      ok: false,
      error: "restricted",
      message: "A support session cannot change use cases.",
    });
  }
  return {
    project: scope.project,
    organization: scope.organization,
    externalId: session.user.externalId,
  };
}

function selectorOrResponse(input: unknown) {
  try {
    return parseSelector(input);
  } catch (err) {
    if (err instanceof SelectorError)
      return json(400, { ok: false, error: err.code, message: err.message });
    throw err;
  }
}

async function written(
  result: { ok: true; useCase: UseCase } | { ok: false; reason: UseCaseRejection },
  event: UseCaseEvent["name"],
  scope: Scope,
  deps: UseCaseApiDeps,
  status: number,
): Promise<Response> {
  if (!result.ok) {
    logger.info(
      { project_id: scope.project.id, action: event, reason: result.reason, outcome: "rejected" },
      "use case write refused",
    );
    return rejection(result.reason);
  }
  logger.info(
    {
      project_id: scope.project.id,
      use_case_id: result.useCase.id,
      action: event,
      outcome: "saved",
    },
    "use case written",
  );
  await deps.track({
    name: event,
    externalId: scope.externalId,
    projectId: scope.project.id,
    organizationId: scope.organization.id,
    useCase: result.useCase,
  });
  return json(status, { ok: true, useCase: viewOfUseCase(result.useCase) });
}

function rejection(reason: UseCaseRejection): Response {
  const { status, message } = USE_CASE_REJECTIONS[reason];
  return json(status, { ok: false, error: reason, message });
}

function invalid(error: z.ZodError): Response {
  const issue = error.issues[0];
  const code = issue?.code === "unrecognized_keys" ? "unknown_key" : "invalid";
  return json(400, { ok: false, error: code, message: issue?.message ?? "Invalid use case." });
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}
