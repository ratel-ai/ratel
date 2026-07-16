import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CatalogLoader, Skill, SkillCatalog } from "@ratel-ai/sdk";
import { parse as parseYaml } from "yaml";

/** Construction options for {@link LocalSkillsLoader}. */
export interface LocalSkillsLoaderOptions {
  /** Directory of `<name>/SKILL.md` folders to load. Default `~/.ratel/skills`. */
  dir?: string;
}

/** A file the loader could not turn into a skill, and why. Replaced per scan. */
export interface LocalSkillDiagnostic {
  /** Absolute path of the SKILL.md that was skipped. */
  path: string;
  /** Human-readable reason (malformed frontmatter, missing/typed field, duplicate id). */
  reason: string;
}

/**
 * The reference {@link CatalogLoader}: mirror a directory of `<name>/SKILL.md`
 * files (the `.claude/skills` convention; default `~/.ratel/skills`, ADR-0005)
 * into a {@link SkillCatalog}. Non-recursive, sorted scan — only immediate
 * `<dir>/<name>/SKILL.md` files count; a subdirectory without a SKILL.md is
 * ignored. Each file is YAML frontmatter (fenced at byte 0) plus a Markdown
 * body.
 *
 * It owns no watcher: {@link LocalSkillsLoader.start} does one pass and
 * {@link LocalSkillsLoader.refresh} does another on demand. A bad file is
 * skipped and recorded in {@link LocalSkillsLoader.diagnostics} rather than
 * failing the whole scan.
 */
export class LocalSkillsLoader implements CatalogLoader {
  /** The resolved directory this loader scans. */
  readonly dir: string;
  private catalog: SkillCatalog | undefined;
  // id -> raw file text of the last-synced version; the change fingerprint and
  // the set of ids this loader owns (so refresh never removes foreign skills).
  private loaded = new Map<string, string>();
  private diags: LocalSkillDiagnostic[] = [];

  constructor(options: LocalSkillsLoaderOptions = {}) {
    this.dir = options.dir ?? join(homedir(), ".ratel", "skills");
  }

  /** Files skipped by the most recent scan, and why. Empty after a clean scan. */
  get diagnostics(): readonly LocalSkillDiagnostic[] {
    return this.diags;
  }

  /**
   * Store the catalog, scan the directory once, and `upsert` every valid skill.
   * Throws if already started (call {@link LocalSkillsLoader.stop} first).
   *
   * @param catalog - The catalog to hydrate and keep in sync.
   */
  async start(catalog: SkillCatalog): Promise<void> {
    if (this.catalog) {
      throw new Error("loader already started; stop it before starting again");
    }
    this.catalog = catalog;
    await this.sync();
  }

  /**
   * Re-scan now: `upsert` new or changed files (raw-text equality is the
   * fingerprint, so an untouched file is not re-embedded), and `remove` ids that
   * have vanished — but only ids this loader previously loaded, never foreign
   * skills another writer put in the catalog. Throws before `start`.
   */
  async refresh(): Promise<void> {
    if (!this.catalog) {
      throw new Error("loader not started; call start(catalog) first");
    }
    await this.sync();
  }

  /**
   * Forget the catalog and the loaded-set; the skills stay in the catalog
   * (ADR-0003 offline semantics — the last-synced catalog survives). Restartable;
   * a no-op before `start`. No filesystem watcher is torn down (there is none).
   */
  async stop(): Promise<void> {
    this.catalog = undefined;
    this.loaded = new Map();
    this.diags = [];
  }

  /** One scan-and-reconcile pass against the current catalog. */
  private async sync(): Promise<void> {
    const catalog = this.catalog;
    if (!catalog) {
      return; // unreachable: start/refresh guard first
    }
    const { skills, diagnostics } = await this.scan();
    const next = new Map<string, string>();
    for (const [id, { skill, raw }] of skills) {
      next.set(id, raw);
      if (this.loaded.get(id) !== raw) {
        catalog.upsert(skill);
      }
    }
    for (const id of this.loaded.keys()) {
      if (!next.has(id)) {
        catalog.remove(id);
      }
    }
    this.loaded = next;
    this.diags = diagnostics;
  }

  /** Read every `<dir>/<name>/SKILL.md`, parsing each; collect skills + diagnostics. */
  private async scan(): Promise<ScanResult> {
    const skills = new Map<string, ScannedSkill>();
    const diagnostics: LocalSkillDiagnostic[] = [];

    let names: string[];
    try {
      const entries = await readdir(this.dir, { withFileTypes: true });
      names = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch (err) {
      if (isErrno(err, "ENOENT")) {
        return { skills, diagnostics }; // missing dir → empty, not an error
      }
      throw err;
    }

    for (const name of names) {
      const filePath = join(this.dir, name, "SKILL.md");
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (err) {
        if (isErrno(err, "ENOENT")) {
          continue; // a directory without a SKILL.md is ignored
        }
        diagnostics.push({ path: filePath, reason: `cannot read file: ${errMessage(err)}` });
        continue;
      }

      const parsed = parseSkillFile(raw, name);
      if (!parsed.ok) {
        diagnostics.push({ path: filePath, reason: parsed.reason });
        continue;
      }
      if (skills.has(parsed.skill.id)) {
        diagnostics.push({
          path: filePath,
          reason: `duplicate id "${parsed.skill.id}" (first sorted directory wins)`,
        });
        continue;
      }
      skills.set(parsed.skill.id, { skill: parsed.skill, raw });
    }
    return { skills, diagnostics };
  }
}

interface ScannedSkill {
  skill: Skill;
  raw: string;
}

interface ScanResult {
  skills: Map<string, ScannedSkill>;
  diagnostics: LocalSkillDiagnostic[];
}

type ParseResult = { ok: true; skill: Skill } | { ok: false; reason: string };

/** Parse one SKILL.md into a {@link Skill}, or a reason it can't be. */
function parseSkillFile(raw: string, dirName: string): ParseResult {
  const split = splitFrontmatter(raw);
  if (!split) {
    return { ok: false, reason: "missing YAML frontmatter (expected a --- fence at byte 0)" };
  }

  let data: unknown;
  try {
    data = parseYaml(split.yaml);
  } catch (err) {
    return { ok: false, reason: `invalid YAML frontmatter: ${errMessage(err)}` };
  }
  if (data === null || data === undefined) {
    data = {};
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "frontmatter is not a mapping" };
  }
  const fm = data as Record<string, unknown>;

  const id = fm.id === undefined ? dirName : fm.id;
  if (typeof id !== "string" || id.length === 0) {
    return { ok: false, reason: "field `id` must be a non-empty string" };
  }
  const name = fm.name === undefined ? id : fm.name;
  if (typeof name !== "string") {
    return { ok: false, reason: "field `name` must be a string" };
  }
  if (typeof fm.description !== "string" || fm.description.length === 0) {
    return { ok: false, reason: "field `description` is required and must be a non-empty string" };
  }
  const tags = asStringList(fm.tags, "tags");
  if ("error" in tags) {
    return { ok: false, reason: tags.error };
  }
  const tools = asStringList(fm.tools, "tools");
  if ("error" in tools) {
    return { ok: false, reason: tools.error };
  }
  const metadata = asStringListMap(fm.metadata, "metadata");
  if ("error" in metadata) {
    return { ok: false, reason: metadata.error };
  }

  return {
    ok: true,
    skill: {
      id,
      name,
      description: fm.description,
      tags: tags.value,
      tools: tools.value,
      metadata: metadata.value,
      body: split.body,
    },
  };
}

/** Split a `---`-fenced document into its YAML head and Markdown body. */
function splitFrontmatter(raw: string): { yaml: string; body: string } | null {
  if (!/^---\r?\n/.test(raw)) {
    return null;
  }
  const lines = raw.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return null; // no closing fence
  }
  const yaml = lines.slice(1, end).join("\n");
  // Body is verbatim after the fence, minus any leading blank lines.
  const body = lines
    .slice(end + 1)
    .join("\n")
    .replace(/^(?:[ \t]*\n)+/, "");
  return { yaml, body };
}

function asStringList(value: unknown, field: string): { value: string[] } | { error: string } {
  if (value === undefined || value === null) {
    return { value: [] };
  }
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    return { error: `field \`${field}\` must be a list of strings` };
  }
  return { value: value as string[] };
}

function asStringListMap(
  value: unknown,
  field: string,
): { value: Record<string, string[]> } | { error: string } {
  if (value === undefined || value === null) {
    return { value: {} };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { error: `field \`${field}\` must be a mapping of string lists` };
  }
  const out: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(entry) || !entry.every((v) => typeof v === "string")) {
      return { error: `field \`${field}.${key}\` must be a list of strings` };
    }
    out[key] = entry as string[];
  }
  return { value: out };
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === code;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
