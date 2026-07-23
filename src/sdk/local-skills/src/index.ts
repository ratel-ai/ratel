/**
 * `@ratel-ai/local-skills` — the reference {@link CatalogLoader} for Ratel: load
 * a directory of `<name>/SKILL.md` files (default `~/.ratel/skills`, ADR-0005)
 * into a `SkillCatalog`. Pair it with `attachLoader` from `@ratel-ai/sdk` to
 * hydrate a catalog and keep it in sync.
 *
 * @example
 * ```ts
 * import { attachLoader, SkillCatalog } from "@ratel-ai/sdk";
 * import { LocalSkillsLoader } from "@ratel-ai/local-skills";
 *
 * const catalog = new SkillCatalog();
 * const handle = await attachLoader(catalog, new LocalSkillsLoader());
 * // ... search/invoke against ~/.ratel/skills ...
 * await handle.refresh(); // pick up on-disk edits
 * ```
 *
 * @packageDocumentation
 */

export type { LocalSkillDiagnostic, LocalSkillsLoaderOptions } from "./local-skills-loader.js";
export { LocalSkillsLoader } from "./local-skills-loader.js";
