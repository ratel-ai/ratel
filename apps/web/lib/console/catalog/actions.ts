import type { ToastOptions } from "@ratel/design-system/toast";
import type { SkillFull } from "@/lib/catalog/agent-tools/outputs";
import type { MutationResult } from "@/lib/console/explore/client";
import {
  type CatalogItem,
  type SearchableTarget,
  type SkillTransition,
  skillStatus,
  transitionStatus,
  undoTransition,
} from "./items";
import { type SavePlan, storedValue } from "./searchable";

/**
 * The Catalog's writes as plain async flows: what to call, what to say, and
 * what Undo does. The client store injects the real routes and the toast;
 * tests inject fakes. Undo always starts from the latest state this page
 * knows, so it never writes over a newer save or trips on a bumped version.
 */

export type WriteResult = { ok: true; target: SearchableTarget } | { ok: false; error: string };

export const NOT_EDITABLE = "This description can't be edited here.";

export interface SearchableActionDeps {
  /** Store `stored` (null clears) where the target lives; resolves to the target as saved. */
  write(target: SearchableTarget, stored: string | null): Promise<WriteResult>;
  /** The same entry as this page last saw it, after every write since it loaded; undefined when untouched. */
  current(target: SearchableTarget): SearchableTarget | undefined;
  toast(options: ToastOptions): void;
}

/** Carry out a save plan. Resolves to an error for under the field, or null once saved (or nothing changed). */
export async function commitSearchable(
  deps: SearchableActionDeps,
  item: CatalogItem,
  plan: SavePlan,
): Promise<string | null> {
  const searchable = item.searchable;
  if (!searchable?.editable) return NOT_EDITABLE;
  if (plan.type === "noop") return null;
  if (plan.type === "invalid") return plan.error;
  const result = await deps.write(searchable.target, plan.stored);
  if (!result.ok) return result.error;
  const written = storedValue(result.target);
  deps.toast({
    title: "Searchable description saved",
    description: item.name,
    tone: "success",
    action: {
      label: "Undo",
      onClick: () => void undoSearchable(deps, item.name, result.target, written, plan.previous),
    },
  });
  return null;
}

/** Write the value from before a save back, unless the text changed again since. */
export async function undoSearchable(
  deps: SearchableActionDeps,
  name: string,
  saved: SearchableTarget,
  written: string | null,
  previous: string | null,
): Promise<void> {
  const latest = deps.current(saved) ?? saved;
  if (storedValue(latest) !== written) {
    deps.toast({
      title: "Nothing to undo",
      description: `The description of ${name} changed again after that save.`,
    });
    return;
  }
  const undone = await deps.write(latest, previous);
  deps.toast(
    undone.ok
      ? { title: "Previous description restored", description: name }
      : {
          title: "Couldn't restore the previous description",
          description: undone.error,
          tone: "danger",
        },
  );
}

export interface TransitionDeps {
  setStatus(
    id: string,
    transition: SkillTransition,
    expectedVersion: number,
  ): Promise<MutationResult<SkillFull>>;
  /** Show a record the server returned everywhere at once. */
  apply(record: SkillFull): void;
  /** The newest copy of a skill this page has. */
  latest(id: string): SkillFull | undefined;
  /** Words for a failed write. */
  explain(result: Extract<MutationResult<unknown>, { ok: false }>): string;
  toast(options: ToastOptions): void;
}

/**
 * Publish or archive a Cloud skill at once, and say so. Undo is offered only
 * when the opposite move restores the exact status it left: published and
 * archived swap back, but nothing returns a skill to draft.
 */
export async function transitionSkill(
  deps: TransitionDeps,
  record: SkillFull,
  transition: SkillTransition,
): Promise<void> {
  const from = skillStatus(record.status);
  const result = await deps.setStatus(record.id, transition, record.version);
  if (!result.ok) {
    deps.toast({
      title: transition === "publish" ? "Couldn't publish the skill" : "Couldn't archive the skill",
      description: deps.explain(result),
      tone: "danger",
    });
    return;
  }
  deps.apply(result.data);
  const to = transitionStatus(transition);
  const back = from ? undoTransition(from, to) : null;
  deps.toast({
    title: transition === "publish" ? "Skill published" : "Skill archived",
    description: back
      ? record.name
      : transition === "publish"
        ? `${record.name} is live. Archive it to take it out again.`
        : `${record.name} is out of the catalog. Publish it to bring it back.`,
    tone: "success",
    action: back
      ? {
          label: "Undo",
          onClick: () => void undoSkillTransition(deps, record.name, result.data, back),
        }
      : undefined,
  });
}

/** Move a skill back, unless something else moved it since. */
export async function undoSkillTransition(
  deps: TransitionDeps,
  name: string,
  moved: SkillFull,
  back: SkillTransition,
): Promise<void> {
  const latest = deps.latest(moved.id) ?? moved;
  if (latest.status !== moved.status) {
    deps.toast({ title: "Nothing to undo", description: `${name} changed again after that.` });
    return;
  }
  const undone = await deps.setStatus(moved.id, back, latest.version);
  if (!undone.ok) {
    deps.toast({ title: "Couldn't undo", description: deps.explain(undone), tone: "danger" });
    return;
  }
  deps.apply(undone.data);
  deps.toast({
    title: back === "publish" ? "Skill published again" : "Skill archived again",
    description: name,
  });
}
