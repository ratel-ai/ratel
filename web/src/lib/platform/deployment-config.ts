import { type Config, getConfig } from "@/config";
import { normalizeOrganizationSettings, slugify } from "@/lib/platform/organization";

type DeploymentConfig = Pick<Config, "app" | "database" | "traceSignals">;

const isOss = (config: DeploymentConfig) => config.app.composition === "oss";

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The compose default, and public: `.env.example` and `docker-compose.yml` both carry it. */
const DEFAULT_DATABASE_PASSWORD = "ratel";

/** `app.organizationName` (RATEL_ORG_NAME), or null when unset. Throws on a name the settings form would refuse. */
export function configuredOrganizationName(config: DeploymentConfig = getConfig()): string | null {
  if (!isOss(config)) return null;
  const name = config.app.organizationName;
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

/** What a deployment with a public `app.baseUrl` (BASE_URL) left at its public defaults. Names, never values. */
export function exposureWarnings(config: DeploymentConfig = getConfig()): string[] {
  if (!isOss(config) || !isPublicUrl(config.app.baseUrl)) return [];
  const warnings: string[] = [];
  if (databasePassword(config.database.url) === DEFAULT_DATABASE_PASSWORD) {
    warnings.push("POSTGRES_PASSWORD is the public default; recreate the database with your own");
  }
  if (!config.traceSignals.hashSalt) {
    warnings.push("TRACE_SIGNALS_HASH_SALT is not set; hashes use the public development salt");
  }
  return warnings;
}
