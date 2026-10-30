import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToastOptions } from "@ratel/design-system/toast";
import type { SkillFull } from "@/lib/catalog/agent-tools/outputs";
import {
  commitSearchable,
  NOT_EDITABLE,
  type SearchableActionDeps,
  type TransitionDeps,
  transitionSkill,
} from "./actions";
import type { CatalogItem, SearchableTarget } from "./items";
import { planSearchableSave, targetAfterWrite } from "./searchable";
import { runtimeDefinition, skillItems, skillRecord, toolItems } from "./test-support";

/** Let a fire-and-forget Undo finish. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function keyOf(target: SearchableTarget): string {
  return target.type === "runtime" ? `${target.kind}:${target.entryId}` : `skill:${target.skillId}`;
}

/** Routes that always succeed, a skill version that bumps on every write, and a toast that records. */
function searchableFakes(options: { fail?: string } = {}) {
  const toasts: ToastOptions[] = [];
  const writes: { target: SearchableTarget; stored: string | null }[] = [];
  const latest = new Map<string, SearchableTarget>();
  const deps: SearchableActionDeps = {
    async write(target, stored) {
      writes.push({ target, stored });
      if (options.fail) return { ok: false, error: options.fail };
      const saved = targetAfterWrite(
        target,
        stored,
        target.type === "skill" ? target.version + 1 : undefined,
      );
      latest.set(keyOf(target), saved);
      return { ok: true, target: saved };
    },
    current: (target) => latest.get(keyOf(target)),
    toast: (toast) => void toasts.push(toast),
  };
  return { deps, toasts, writes, latest };
}

function save(deps: SearchableActionDeps, item: CatalogItem, draft: string) {
  assert.ok(item.searchable);
  return commitSearchable(
    deps,
    item,
    planSearchableSave(item.searchable.target, item.agentDescription ?? "", draft),
  );
}

/** The item as the page shows it after a write: the latest target. */
function withTarget(item: CatalogItem, target: SearchableTarget): CatalogItem {
  assert.ok(item.searchable);
  return { ...item, searchable: { ...item.searchable, target } } as CatalogItem;
}

const [ripgrep] = toolItems({
  definitions: [runtimeDefinition("ripgrep", { description: "Search a working tree." })],
});

test("a save writes the new text, says so, and its Undo writes the old value back", async () => {
  const { deps, toasts, writes } = searchableFakes();
  assert.equal(await save(deps, ripgrep, "grep files for a regex"), null);
  assert.deepEqual(
    writes.map((write) => write.stored),
    ["grep files for a regex"],
  );
  assert.equal(toasts[0].title, "Searchable description saved");
  assert.equal(toasts[0].tone, "success");
  assert.equal(toasts[0].action?.label, "Undo");

  toasts[0].action?.onClick();
  await settle();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].stored, null, "there was no Cloud copy before, so Undo clears it");
  assert.equal(
    writes[1].target.type === "runtime" && writes[1].target.override,
    "grep files for a regex",
    "Undo starts from the saved state",
  );
  assert.equal(toasts[1].title, "Previous description restored");
});

test("nothing to save writes nothing and says nothing", async () => {
  const { deps, toasts, writes } = searchableFakes();
  assert.equal(await save(deps, ripgrep, "Search a working tree."), null);
  assert.equal(writes.length, 0);
  assert.equal(toasts.length, 0);
});

test("a refused draft or a failed write comes back as the field's error, with no toast", async () => {
  const refused = searchableFakes();
  assert.match((await save(refused.deps, ripgrep, "x".repeat(5000))) ?? "", /4,096 characters/);
  assert.equal(refused.writes.length, 0);

  const failing = searchableFakes({
    fail: "Couldn't save the description. Try again in a moment.",
  });
  assert.equal(
    await save(failing.deps, ripgrep, "new text"),
    "Couldn't save the description. Try again in a moment.",
  );
  assert.equal(failing.toasts.length, 0);
});

test("a read-only item cannot be saved", async () => {
  const { deps, writes } = searchableFakes();
  const [readOnly] = toolItems({ definitions: [runtimeDefinition("ripgrep")], editable: false });
  assert.equal(await save(deps, readOnly, "anything"), NOT_EDITABLE);
  assert.equal(writes.length, 0);
});

test("Undo after a newer save leaves the newer one alone", async () => {
  const { deps, toasts, writes, latest } = searchableFakes();
  await save(deps, ripgrep, "first");
  const afterFirst = latest.get("tool:ripgrep");
  assert.ok(afterFirst);
  await save(deps, withTarget(ripgrep, afterFirst), "second");

  toasts[0].action?.onClick();
  await settle();
  assert.equal(writes.length, 2, "the first save's Undo writes nothing");
  assert.equal(toasts.at(-1)?.title, "Nothing to undo");
});

test("Undo of a skill save uses the newest version, whatever bumped it since", async () => {
  const { deps, toasts, writes, latest } = searchableFakes();
  const [skill] = skillItems({ skills: [skillRecord("review-pull-request", { version: 4 })] });
  await save(deps, skill, "review a PR diff");
  assert.equal(writes[0].target.type === "skill" && writes[0].target.version, 4);
  // An archive in between bumps the version without touching the text.
  const saved = latest.get("skill:id-review-pull-request");
  assert.ok(saved?.type === "skill");
  latest.set("skill:id-review-pull-request", { ...saved, version: 7 });

  toasts[0].action?.onClick();
  await settle();
  assert.deepEqual(writes[1], {
    target: {
      type: "skill",
      skillId: "id-review-pull-request",
      version: 7,
      stored: "review a PR diff",
    },
    stored: null,
  });
});

/** A skills route that checks versions like the real one, and a toast that records. */
function transitionFakes(initial: SkillFull) {
  let server = initial;
  const toasts: ToastOptions[] = [];
  const calls: { transition: string; expectedVersion: number }[] = [];
  const latest = new Map<string, SkillFull>();
  const deps: TransitionDeps = {
    async setStatus(_id, transition, expectedVersion) {
      calls.push({ transition, expectedVersion });
      if (expectedVersion !== server.version)
        return { ok: false, status: 409, reason: "version_conflict" };
      server = {
        ...server,
        status: transition === "publish" ? "published" : "archived",
        version: server.version + 1,
      };
      return { ok: true, data: server };
    },
    apply: (record) => void latest.set(record.id, record),
    latest: (id) => latest.get(id),
    explain: (result) => `failed: ${result.reason ?? result.status}`,
    toast: (toast) => void toasts.push(toast),
  };
  return { deps, toasts, calls, latest, server: () => server };
}

test("archiving a published skill offers Undo, which publishes it again on the new version", async () => {
  const record = skillRecord("deploy-service", { status: "published", version: 2 });
  const fakes = transitionFakes(record);
  await transitionSkill(fakes.deps, record, "archive");
  assert.equal(fakes.server().status, "archived");
  assert.equal(fakes.latest.get(record.id)?.status, "archived", "the page shows it at once");
  assert.equal(fakes.toasts[0].title, "Skill archived");
  assert.equal(fakes.toasts[0].action?.label, "Undo");

  fakes.toasts[0].action?.onClick();
  await settle();
  assert.deepEqual(fakes.calls.at(-1), { transition: "publish", expectedVersion: 3 });
  assert.equal(fakes.server().status, "published");
  assert.equal(fakes.toasts.at(-1)?.title, "Skill published again");
});

test("leaving draft has no Undo, and the toast says how to bring it back", async () => {
  const record = skillRecord("write-unit-tests", { status: "draft", version: 1 });
  const fakes = transitionFakes(record);
  await transitionSkill(fakes.deps, record, "archive");
  assert.equal(fakes.toasts[0].action, undefined);
  assert.match(fakes.toasts[0].description ?? "", /Publish it to bring it back/);
});

test("a refused transition says so and changes nothing", async () => {
  const record = skillRecord("deploy-service", { status: "published", version: 2 });
  const fakes = transitionFakes({ ...record, version: 3 });
  await transitionSkill(fakes.deps, record, "archive");
  assert.equal(fakes.toasts[0].title, "Couldn't archive the skill");
  assert.equal(fakes.toasts[0].tone, "danger");
  assert.equal(fakes.toasts[0].description, "failed: version_conflict");
  assert.equal(fakes.latest.size, 0);
});

test("Undo after the skill moved again changes nothing", async () => {
  const record = skillRecord("deploy-service", { status: "published", version: 2 });
  const fakes = transitionFakes(record);
  await transitionSkill(fakes.deps, record, "archive");
  fakes.deps.apply({ ...record, status: "published", version: 9 });

  fakes.toasts[0].action?.onClick();
  await settle();
  assert.equal(fakes.calls.length, 1, "no second call");
  assert.equal(fakes.toasts.at(-1)?.title, "Nothing to undo");
});
