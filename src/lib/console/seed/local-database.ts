/**
 * Whether a database URL, and the libpq environment beside it, can only reach
 * this machine. Scripts that write fake data or destroy state check it before
 * they connect.
 *
 * Parsed with `new URL`, never matched with a pattern. A connection string can
 * name its host in the query (`?host=`, `?hostaddr=`), which the Postgres
 * clients prefer over the authority, and a pattern that finds `@localhost`
 * anywhere passes `postgres://u:p@prod.example.com/db?application_name=x@localhost/`.
 */

type Environment = Readonly<Record<string, string | undefined>>;

/** The only hosts a local script may reach, compared case-insensitively. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1"]);

/** Query parameters that can move a connection to another host or port, or to a service file that does. */
const REDIRECTING_PARAMS: ReadonlySet<string> = new Set(["host", "hostaddr", "port", "service"]);

const unbracket = (host: string) => host.replace(/^\[(.*)\]$/, "$1");

function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(unbracket(host.trim().toLowerCase()));
}

/**
 * Why `url` (with `env`) might reach another machine, or null when it can only
 * reach this one. `PGHOST` may also name a socket directory, which is local.
 */
export function localDatabaseProblem(
  url: string | undefined,
  env: Environment = process.env,
): string | null {
  if (!url) return "DATABASE_URL is not set";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "DATABASE_URL is not a valid URL";
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return `DATABASE_URL is a ${parsed.protocol.replace(/:$/, "")} URL, not a postgres one`;
  }
  if (!isLocalHost(parsed.hostname)) {
    return parsed.hostname
      ? `DATABASE_URL points at ${unbracket(parsed.hostname)}, not this machine`
      : "DATABASE_URL names no host";
  }
  for (const key of parsed.searchParams.keys()) {
    if (REDIRECTING_PARAMS.has(key.toLowerCase()))
      return `DATABASE_URL sets "${key}" in its query, which can point the connection elsewhere`;
  }
  for (const name of ["PGHOST", "PGHOSTADDR"] as const) {
    const value = env[name]?.trim();
    if (!value) continue;
    for (const host of value.split(",")) {
      const local = isLocalHost(host) || (name === "PGHOST" && host.trim().startsWith("/"));
      if (!local) return `${name} is set to ${host.trim()}, not this machine`;
    }
  }
  return null;
}

/** Throw unless the configured database is on this machine. `purpose` finishes "refusing to ...". */
export function assertLocalDatabase(purpose: string, env: Environment = process.env): void {
  const problem = localDatabaseProblem(env.DATABASE_URL, env);
  if (problem)
    throw new Error(
      `refusing to ${purpose}: ${problem}. Point DATABASE_URL at your local Postgres.`,
    );
}
