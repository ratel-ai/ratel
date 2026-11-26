import { type SealedSecretsKey, unsealSecret } from "@/lib/platform/sealed-secrets";
import type { SecretStore } from "./ports/secret-store";

export type SecretValuesDeps = {
  secrets: Pick<SecretStore, "readSealed">;
  sealingKey: () => SealedSecretsKey;
};

export type SecretValues =
  | { ok: true; values: Record<string, string> }
  | { ok: false; reason: "not_configured" | "missing_secrets"; message: string };

/** The clear values of these secrets of a project, and of no other secret. */
export async function openSecretValues(
  projectId: string,
  names: readonly string[],
  deps: SecretValuesDeps,
): Promise<SecretValues> {
  if (names.length === 0) return { ok: true, values: {} };
  const sealing = deps.sealingKey();
  if (!sealing.ok) return { ok: false, reason: "not_configured", message: sealing.message };
  const sealed = await deps.secrets.readSealed(projectId, names);
  const missing = names.filter((name) => !sealed.has(name));
  if (missing.length > 0) {
    const message = `Set these secrets first: ${missing.join(", ")}.`;
    return { ok: false, reason: "missing_secrets", message };
  }
  const values: Record<string, string> = {};
  for (const name of names) {
    try {
      values[name] = unsealSecret(sealing.key, { projectId, name }, sealed.get(name) ?? "");
    } catch {
      const message = `The secret ${name} does not open any more. Set it again.`;
      return { ok: false, reason: "missing_secrets", message };
    }
  }
  return { ok: true, values };
}

/** The variables in the `--env-file` form of Docker: one `NAME=value` a line. */
export function envFile(env: Record<string, string>): string {
  const lines = Object.entries(env).map(([name, value]) => {
    // The form has no way to hold a line break. The message names the variable, not its value.
    if (/[\r\n]/.test(value)) throw new Error(`the variable ${name} holds a line break`);
    return `${name}=${value}\n`;
  });
  return lines.join("");
}
