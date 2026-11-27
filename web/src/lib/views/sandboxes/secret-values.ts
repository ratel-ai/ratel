import { type SealedSecretsKey, unsealSecret } from "@/lib/platform/sealed-secrets";
import type { SealedSecretRow, SecretStore } from "./ports/secret-store";

export type SecretValuesDeps = {
  secrets: Pick<SecretStore, "readSealed">;
  sealingKey: () => SealedSecretsKey;
};

/** Where the value of a declared name comes from: the sandbox wins over the project. */
export type SecretSource = "sandbox" | "project" | "missing";

/** The project, and the sandbox whose secrets win over the project secrets. */
export type SecretLevel = { projectId: string; sandboxName: string | null };

export type SecretValues =
  | { ok: true; values: Record<string, string> }
  | { ok: false; reason: "not_configured" | "missing_secrets"; message: string };

/**
 * The clear values of these secrets, and of no other secret. A name takes the value of the
 * sandbox, else the value of the project. A name with neither refuses the whole set, with its name.
 */
export async function openSecretValues(
  level: SecretLevel,
  names: readonly string[],
  deps: SecretValuesDeps,
): Promise<SecretValues> {
  if (names.length === 0) return { ok: true, values: {} };
  const sealing = deps.sealingKey();
  if (!sealing.ok) return { ok: false, reason: "not_configured", message: sealing.message };
  const rows = await deps.secrets.readSealed(level.projectId, names, level.sandboxName);
  const chosen = chooseRows(names, rows);
  const missing = names.filter((name) => !chosen.has(name));
  if (missing.length > 0) {
    const message = `Set these secrets first: ${missing.join(", ")}.`;
    return { ok: false, reason: "missing_secrets", message };
  }
  const values: Record<string, string> = {};
  for (const [name, row] of chosen) {
    const owner = { projectId: level.projectId, name, sandboxName: row.sandboxName };
    try {
      values[name] = unsealSecret(sealing.key, owner, row.sealedValue);
    } catch {
      const message = `The secret ${name} does not open any more. Set it again.`;
      return { ok: false, reason: "missing_secrets", message };
    }
  }
  return { ok: true, values };
}

/** The source of each name, in the order of `names`. It reads no value. */
export function secretSources(
  names: readonly string[],
  rows: ReadonlyArray<Pick<SealedSecretRow, "name" | "sandboxName">>,
): Array<{ name: string; source: SecretSource }> {
  const chosen = chooseRows(names, rows);
  return names.map((name) => {
    const row = chosen.get(name);
    return { name, source: !row ? "missing" : row.sandboxName === null ? "project" : "sandbox" };
  });
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

/** One row a declared name: the sandbox row when there is one, else the project row. */
function chooseRows<Row extends Pick<SealedSecretRow, "name" | "sandboxName">>(
  names: readonly string[],
  rows: readonly Row[],
): Map<string, Row> {
  const declared = new Set(names);
  const chosen = new Map<string, Row>();
  for (const row of rows) {
    if (!declared.has(row.name)) continue;
    const seen = chosen.get(row.name);
    if (!seen || (seen.sandboxName === null && row.sandboxName !== null)) chosen.set(row.name, row);
  }
  return chosen;
}
