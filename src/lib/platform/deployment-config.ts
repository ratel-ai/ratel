import { normalizeOrganizationSettings, slugify } from "@/lib/platform/organization";

type Env = Readonly<Record<string, string | undefined>>;

const isOss = (env: Env) => (env.RATEL_COMPOSITION || "oss") === "oss";

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The compose default, and public: `.env.example` and `docker-compose.yml` both carry it. */
const DEFAULT_DATABASE_PASSWORD = "ratel";

/** `RATEL_ORG_NAME`, or null when unset. Throws on a name the settings form would refuse. */
export function configuredOrganizationName(env: Env = process.env): string | null {
  if (!isOss(env)) return null;
  const name = env.RATEL_ORG_NAME?.trim();
  if (!name) return null;
  const normalized = normalizeOrganizationSettings({ name, slug: slugify(name) || "org" });
  if (!normalized.ok) throw new Error(`RATEL_ORG_NAME: ${normalized.error}`);
  return normalized.name;
}

function isPublicUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return !LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function databasePassword(url: string | undefined): string | null {
  try {
    return url ? decodeURIComponent(new URL(url).password) : null;
  } catch {
    return null;
  }
}

/** What a deployment with a public `BASE_URL` left at its public defaults. Names, never values. */
export function exposureWarnings(env: Env = process.env): string[] {
  if (!isOss(env) || !isPublicUrl(env.BASE_URL)) return [];
  const warnings: string[] = [];
  if (databasePassword(env.DATABASE_URL) === DEFAULT_DATABASE_PASSWORD) {
    warnings.push("POSTGRES_PASSWORD is the public default; recreate the database with your own");
  }
  const salt = env.TRACE_SIGNALS_HASH_SALT?.trim();
  if (!salt || salt === "REPLACE_ME") {
    warnings.push("TRACE_SIGNALS_HASH_SALT is not set; hashes use the public development salt");
  }
  return warnings;
}
