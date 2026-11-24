import { changeLayout, DEFAULT_LAYOUT, type OverviewLayout } from "./domain/layout";
import { layoutChangeSchema } from "./domain/stored";
import type { OverviewLayoutStore } from "./ports/store";

/**
 * Reading and changing the Overview layout, for the web and for MCP alike. Who asks is decided by
 * the caller's boundary (the console scope, or the MCP credential) and comes in as `LayoutReader`.
 */

export type LayoutReader =
  /** Somebody with access to the project. `restricted`: in a support session, which reads the default. */
  | { kind: "person"; projectId: string; personId: string; restricted: boolean }
  /** An API key is no person: it has no layout of its own. */
  | { kind: "api-key" };

export interface LayoutDeps {
  /** Null for somebody who is signed out or has no access to the project. */
  reader: (projectId: string) => Promise<LayoutReader | null>;
  store: () => OverviewLayoutStore;
}

export type LayoutRefusal = "not_found" | "api_key" | "support_session" | "invalid";

export type LayoutResult =
  | { ok: true; layout: OverviewLayout }
  | { ok: false; reason: LayoutRefusal };

export const LAYOUT_REFUSALS: Readonly<Record<LayoutRefusal, string>> = {
  not_found: "No project you belong to has that ID.",
  api_key:
    "An API key has no Overview layout. Sign in to the MCP server as a person to change the layout.",
  support_session: "A support session cannot change the Overview.",
  invalid: "That is not a change the Overview can make.",
};

export async function readOverviewLayout(
  projectId: string,
  deps: LayoutDeps,
): Promise<LayoutResult> {
  const reader = await deps.reader(projectId);
  if (!reader) return { ok: false, reason: "not_found" };
  if (reader.kind === "api-key" || reader.restricted) return { ok: true, layout: DEFAULT_LAYOUT };
  return { ok: true, layout: await deps.store().read(reader) };
}

export async function changeOverviewLayout(
  projectId: string,
  change: unknown,
  deps: LayoutDeps,
): Promise<LayoutResult> {
  const reader = await deps.reader(projectId);
  if (!reader) return { ok: false, reason: "not_found" };
  if (reader.kind === "api-key") return { ok: false, reason: "api_key" };
  if (reader.restricted) return { ok: false, reason: "support_session" };
  const parsed = layoutChangeSchema.safeParse(change);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const layout = await deps
    .store()
    .update({ projectId: reader.projectId, personId: reader.personId }, (current) =>
      changeLayout(current, parsed.data),
    );
  return { ok: true, layout };
}
