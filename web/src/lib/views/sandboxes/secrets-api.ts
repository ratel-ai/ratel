import { z } from "zod";
import { getLogger } from "@/lib/platform/logger";
import { type SealedSecretsKey, sealSecret } from "@/lib/platform/sealed-secrets";
import { type ConsoleAccessDeps, forMember, type Member, refuse, reply } from "./console-access";
import { secretNameSchema } from "./domain/config";
import type { SecretStore } from "./ports/secret-store";
import { type SecretLevel, secretSources } from "./secret-values";

/**
 * The session routes of sandbox secrets, at the project level and at the level of one sandbox. A
 * value goes in and never comes out.
 */
export type SecretsApiDeps = ConsoleAccessDeps & {
  secrets: () => SecretStore;
  sealingKey: () => SealedSecretsKey;
  /** The secret names that the newest version of the sandbox declares. Null: no such sandbox. */
  declaredSecrets: (projectId: string, sandboxName: string) => Promise<string[] | null>;
  logger?: Pick<ReturnType<typeof getLogger>, "info">;
};

/** A value becomes one variable of the instance. */
const MAX_VALUE_BYTES = 32 * 1024;

const bodySchema = z.object({
  value: z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value) <= MAX_VALUE_BYTES && !value.includes("\0")),
});
const moduleLogger = getLogger("sandboxes/secrets-api");

export function handleListSecrets(projectId: string, deps: SecretsApiDeps): Promise<Response> {
  return forMember(projectId, "list_secrets", deps, async (member) => {
    const secrets = await deps.secrets().list(member.projectId);
    return reply(200, {
      secrets: secrets.map(({ name, updatedAt }) => ({ name, updatedAt: updatedAt.toISOString() })),
    });
  });
}

export function handleSetSecret(
  request: Request,
  projectId: string,
  name: string,
  deps: SecretsApiDeps,
): Promise<Response> {
  return forAdmin(projectId, "set_secret", deps, (member) =>
    setAt(request, { projectId: member.projectId, sandboxName: null }, name, member, deps),
  );
}

export function handleRemoveSecret(
  projectId: string,
  name: string,
  deps: SecretsApiDeps,
): Promise<Response> {
  return forAdmin(projectId, "remove_secret", deps, (member) =>
    removeAt({ projectId: member.projectId, sandboxName: null }, name, deps),
  );
}

/**
 * Each name that the newest version of the sandbox declares, with its source: `sandbox`,
 * `project` or `missing`. Also the sandbox values of names that it does not declare. Never a value.
 */
export function handleListSandboxSecrets(
  projectId: string,
  sandboxName: string,
  deps: SecretsApiDeps,
): Promise<Response> {
  return forMember(projectId, "list_sandbox_secrets", deps, async (member) => {
    const declared = await deps.declaredSecrets(member.projectId, sandboxName);
    if (!declared) return noSandbox();
    const store = deps.secrets();
    const [atProject, atSandbox] = await Promise.all([
      store.list(member.projectId, null),
      store.list(member.projectId, sandboxName),
    ]);
    const rows = [
      ...atProject.map((row) => ({ ...row, sandboxName: null })),
      ...atSandbox.map((row) => ({ ...row, sandboxName })),
    ];
    const updatedAt = new Map(
      rows.map((row) => [`${row.sandboxName ?? ""}/${row.name}`, row.updatedAt]),
    );
    const secrets = secretSources(declared, rows).map(({ name, source }) => {
      const at = updatedAt.get(`${source === "sandbox" ? sandboxName : ""}/${name}`);
      return { name, source, updatedAt: source === "missing" ? null : (at?.toISOString() ?? null) };
    });
    const undeclared = atSandbox
      .filter((row) => !declared.includes(row.name))
      .map(({ name, updatedAt: at }) => ({ name, updatedAt: at.toISOString() }));
    return reply(200, { sandbox: sandboxName, secrets, undeclared });
  });
}

export function handleSetSandboxSecret(
  request: Request,
  projectId: string,
  sandboxName: string,
  name: string,
  deps: SecretsApiDeps,
): Promise<Response> {
  return forAdmin(projectId, "set_sandbox_secret", deps, async (member) => {
    if (!(await deps.declaredSecrets(member.projectId, sandboxName))) return noSandbox();
    return setAt(request, { projectId: member.projectId, sandboxName }, name, member, deps);
  });
}

export function handleRemoveSandboxSecret(
  projectId: string,
  sandboxName: string,
  name: string,
  deps: SecretsApiDeps,
): Promise<Response> {
  return forAdmin(projectId, "remove_sandbox_secret", deps, (member) =>
    removeAt({ projectId: member.projectId, sandboxName }, name, deps),
  );
}

async function setAt(
  request: Request,
  level: SecretLevel,
  name: string,
  member: Member,
  deps: SecretsApiDeps,
): Promise<Response> {
  const parsedName = secretNameSchema.safeParse(name);
  if (!parsedName.success) {
    return refuse(400, "invalid_name", parsedName.error.issues[0]?.message ?? "Invalid name.");
  }
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  // The message of the check is our own: the issue could hold a part of the value.
  if (!body.success) return refuse(400, "invalid_value", "Give a value of at most 32 KB.");
  const sealing = deps.sealingKey();
  if (!sealing.ok) return refuse(503, "not_configured", sealing.message);
  const owner = { ...level, name: parsedName.data };
  const sealed = sealSecret(sealing.key, owner, body.data.value);
  await deps
    .secrets()
    .set(owner.projectId, owner.name, sealed, member.externalId, level.sandboxName);
  (deps.logger ?? moduleLogger).info(
    logFields(level, owner.name),
    level.sandboxName === null ? "sandbox secret set" : "sandbox secret set for one sandbox",
  );
  return reply(200, { name: owner.name, ...sandboxField(level) });
}

async function removeAt(level: SecretLevel, name: string, deps: SecretsApiDeps): Promise<Response> {
  const removed = await deps.secrets().remove(level.projectId, name, level.sandboxName);
  if (!removed) return refuse(404, "not_found", "There is no secret with that name.");
  (deps.logger ?? moduleLogger).info(logFields(level, name), "sandbox secret removed");
  return reply(200, { name, ...sandboxField(level) });
}

function logFields(level: SecretLevel, name: string) {
  return { project_id: level.projectId, secret_name: name, ...sandboxField(level, "sandbox_name") };
}

function sandboxField(level: SecretLevel, key = "sandbox") {
  return level.sandboxName === null ? {} : { [key]: level.sandboxName };
}

function noSandbox(): Response {
  return refuse(404, "not_found", "There is no sandbox with that name.");
}

function forAdmin(
  projectId: string,
  operation: string,
  deps: SecretsApiDeps,
  work: (member: Member) => Promise<Response>,
): Promise<Response> {
  const asAdmin = async (member: Member) =>
    member.role === "admin"
      ? work(member)
      : refuse(403, "not_admin", "Only organization admins can change sandbox secrets.");
  return forMember(projectId, operation, deps, asAdmin, { write: true });
}
