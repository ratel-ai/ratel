export function flagEnvEnabled(raw: string | undefined): boolean {
  return parseFlagEnvValue(raw) === true;
}

export function parseFlagEnvValue(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;

  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

export function envVarNameForFlagKey(key: string): string {
  return `FF_${key.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}`;
}
