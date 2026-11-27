import { z } from "zod";
import { getLogger } from "@/lib/platform/logger";
import { type SealedSecretsKey, sealSecret } from "@/lib/platform/sealed-secrets";
import { type ConsoleAccessDeps, forMember, type Member, refuse, reply } from "./console-access";
import { secretNameSchema } from "./domain/manifest";
import type { SecretStore } from "./ports/secret-store";

/** The session routes of sandbox secrets. A value goes in and never comes out. */
export type SecretsApiDeps = ConsoleAccessDeps & {
  secrets: () => SecretStore;
  sealingKey: () => SealedSecretsKey;
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
  return forAdmin(projectId, "set_secret", deps, async (member) => {
    const parsedName = secretNameSchema.safeParse(name);
    if (!parsedName.success) {
      return refuse(400, "invalid_name", parsedName.error.issues[0]?.message ?? "Invalid name.");
    }
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    // The message of the check is our own: the issue could hold a part of the value.
    if (!body.success) return refuse(400, "invalid_value", "Give a value of at most 32 KB.");
    const sealing = deps.sealingKey();
    if (!sealing.ok) return refuse(503, "not_configured", sealing.message);
    const owner = { projectId: member.projectId, name: parsedName.data };
    const sealed = sealSecret(sealing.key, owner, body.data.value);
    await deps.secrets().set(owner.projectId, owner.name, sealed, member.externalId);
    (deps.logger ?? moduleLogger).info(
      { project_id: owner.projectId, secret_name: owner.name },
      "sandbox secret set",
    );
    return reply(200, { name: owner.name });
  });
}

export function handleRemoveSecret(
  projectId: string,
  name: string,
  deps: SecretsApiDeps,
): Promise<Response> {
  return forAdmin(projectId, "remove_secret", deps, async (member) => {
    const removed = await deps.secrets().remove(member.projectId, name);
    if (!removed) return refuse(404, "not_found", "There is no secret with that name.");
    (deps.logger ?? moduleLogger).info(
      { project_id: member.projectId, secret_name: name },
      "sandbox secret removed",
    );
    return reply(200, { name });
  });
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
