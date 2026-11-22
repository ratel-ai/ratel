import { isAbsolute, posix, win32 } from "node:path";

// The image of a hosted sandbox (phase-2 spec §7): what an instance needs to
// start, in a provider-neutral shape. A provider (Modal, later our own infra)
// maps it to its own image and sidecars. No provider type lives here.

/** Everything a hosted instance of a sandbox needs besides the code. */
export interface ImageSpec {
  /** The base container image, e.g. `node:22-slim`. */
  readonly base: string;
  /** Shell commands run in order at build time, e.g. `pnpm install --frozen-lockfile`. */
  readonly install: readonly string[];
  /** Paths copied into the image, relative to the project root. Default: `["."]` (respects .gitignore). */
  readonly copy: readonly string[];
  /** Services next to the sandbox, e.g. a Postgres database. */
  readonly sidecars: readonly Sidecar[];
  /** Names of the env vars the instance gets from the project secrets. Names only, never values. */
  readonly env: readonly string[];
}

export interface ImageOptions {
  readonly base: string;
  readonly install?: readonly string[];
  readonly copy?: readonly string[];
  readonly sidecars?: readonly Sidecar[];
  readonly env?: readonly string[];
}

export type Sidecar = PostgresSidecar | RedisSidecar;

export interface PostgresSidecar {
  readonly kind: "postgres";
  /** The major version, e.g. "16". Absent: the provider's default. */
  readonly version?: string;
  /** A SQL file run once when the database starts, relative to the project root. */
  readonly seed?: string;
}

export interface RedisSidecar {
  readonly kind: "redis";
  readonly version?: string;
}

/** What run() returns: free text, or one JSON value described by a JSON Schema. */
export type SandboxOutput<O = unknown> = StructuredOutput<O> | TextOutput;

export interface StructuredOutput<O> {
  readonly kind: "structured";
  readonly schema: Readonly<Record<string, unknown>>;
  /**
   * Type-level marker of the output type. Never set at runtime. A method, so it
   * is bivariant: a run() that returns an unrelated type does not compile, and a
   * sandbox with any output still fits `Sandbox`.
   */
  __output?(output: O): void;
}

export interface TextOutput {
  readonly kind: "text";
}

/** run: one instance per run. session: one instance per session, kept across turns. */
export type SandboxState = "run" | "session";

export const SANDBOX_STATES: readonly SandboxState[] = ["run", "session"];

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const VERSION = /^[0-9]+(\.[0-9]+){0,2}$/;

/** Declares the image of a hosted sandbox. Throws a TypeError on a bad field. */
export function image(options: ImageOptions): ImageSpec {
  const problem = imageProblem(options);
  if (problem) throw new TypeError(`sandbox.image: ${problem}`);
  return Object.freeze({
    base: options.base,
    install: Object.freeze([...(options.install ?? [])]),
    copy: Object.freeze((options.copy ?? ["."]).map(normalizeProjectPath)),
    sidecars: Object.freeze(
      (options.sidecars ?? []).map((sidecar) =>
        Object.freeze(
          sidecar.kind === "postgres" && sidecar.seed
            ? { ...sidecar, seed: normalizeProjectPath(sidecar.seed) }
            : { ...sidecar },
        ),
      ),
    ),
    env: Object.freeze([...(options.env ?? [])]),
  });
}

/**
 * A Postgres database next to the sandbox. The instance gets its URL in
 * `DATABASE_URL`. `seed` is a SQL file relative to the project root.
 */
export function postgres(options: { version?: string; seed?: string } = {}): PostgresSidecar {
  if (options.version !== undefined && !VERSION.test(options.version))
    throw new TypeError(`sandbox.postgres: version "${options.version}" is not a version number`);
  if (options.seed !== undefined) {
    const problem = projectPathProblem(options.seed);
    if (problem) throw new TypeError(`sandbox.postgres: seed ${problem}`);
  }
  return Object.freeze({ kind: "postgres", ...options });
}

/** A Redis server next to the sandbox. The instance gets its URL in `REDIS_URL`. */
export function redis(options: { version?: string } = {}): RedisSidecar {
  if (options.version !== undefined && !VERSION.test(options.version))
    throw new TypeError(`sandbox.redis: version "${options.version}" is not a version number`);
  return Object.freeze({ kind: "redis", ...options });
}

/** A structured output: run() returns one JSON value described by `schema`. */
export function output<O>(schema: Readonly<Record<string, unknown>>): StructuredOutput<O> {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema))
    throw new TypeError("sandbox.output: the schema must be a JSON Schema object");
  return Object.freeze({ kind: "structured", schema });
}

/** A text output: run() returns the reply as a string. */
export function text(): TextOutput {
  return Object.freeze({ kind: "text" });
}

/** Why `options` is not a valid image, or null. */
export function imageProblem(options: ImageOptions): string | null {
  if (typeof options.base !== "string" || options.base.trim() === "")
    return "base must be a container image, e.g. node:22-slim";
  for (const command of options.install ?? []) {
    if (typeof command !== "string" || command.trim() === "")
      return "install entries must be non-empty shell commands";
  }
  for (const path of options.copy ?? []) {
    const problem = projectPathProblem(path);
    if (problem) return `copy ${problem}`;
  }
  for (const sidecar of options.sidecars ?? []) {
    if (sidecar?.kind !== "postgres" && sidecar?.kind !== "redis")
      return "sidecars must come from sandbox.postgres() or sandbox.redis()";
  }
  const kinds = (options.sidecars ?? []).map((s) => s.kind);
  const twice = kinds.find((kind, i) => kinds.indexOf(kind) !== i);
  if (twice) return `sidecars: ${twice} is declared twice`;
  for (const name of options.env ?? []) {
    const problem = envNameProblem(name);
    if (problem) return problem;
  }
  return null;
}

/** Why `name` is not an env var name. A `NAME=value` entry is refused: values come from project secrets. */
function envNameProblem(name: unknown): string | null {
  if (typeof name !== "string") return "env entries must be strings";
  if (name.includes("="))
    return `env "${name.slice(0, name.indexOf("="))}=…" holds a value: env lists names only, the values come from the project secrets in Ratel`;
  if (!ENV_NAME.test(name))
    return `env "${name}" is not an env var name: use uppercase letters, digits and '_'`;
  return null;
}

/** Why `path` is not a path inside the project root, or null. */
function projectPathProblem(path: unknown): string | null {
  if (typeof path !== "string" || path.trim() === "") return "paths must be non-empty strings";
  if (isAbsolute(path) || win32.isAbsolute(path))
    return `"${path}" is absolute: use a path relative to the project root`;
  const normalized = normalizeProjectPath(path);
  if (normalized === ".." || normalized.startsWith("../"))
    return `"${path}" leaves the project root`;
  return null;
}

function normalizeProjectPath(path: string): string {
  return posix.normalize(path.replaceAll("\\", "/")).replace(/\/$/, "") || ".";
}
