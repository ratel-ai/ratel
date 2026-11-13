import assert from "node:assert/strict";
import { test } from "node:test";
import type { IntentMapModel, MapCapability, MapTask } from "@/lib/views/intents/map/map-model";
import {
  arrangeRegion,
  COLUMN_MAX,
  DISC_PAD,
  encloseCircles,
  type GlobeHome,
  globeLayout,
  packRegions,
  REGION_GAP,
  TOOL_SPACING,
} from "@/lib/views/intents/map/tool-globe";
import {
  OTHER_HOME,
  SHARED_FROM_TASKS,
  SHARED_HOME,
  toolHomes,
} from "@/lib/views/intents/map/tool-homes";
import { buildToolNetwork } from "@/lib/views/intents/map/tool-network";

function capability(id: string, calls: number, task: string | null): MapCapability {
  return {
    id: `tool:${id}`,
    kind: "tool",
    name: id,
    calls,
    asks: 1,
    missing: false,
    tint: null,
    task,
  };
}

function task(id: string, runs: number, steps: string[], slot: MapTask["slot"] = null): MapTask {
  return { id, name: `Task ${id}`, slot, runs, steps: steps.map((step) => `tool:${step}`) };
}

// Acme's shape: three tools run in the steps of many tasks; the rest each belong to one.
const CAPABILITIES = [
  capability("sync_session", 107, "t_plan"),
  capability("entity_lookup", 82, "t_brain"),
  capability("filter_tasks", 81, "t_plan"),
  capability("update_task", 80, "t_edit"),
  capability("add_comment", 62, "t_comment"),
  capability("create_task", 58, "t_edit"),
  capability("search_projects", 55, "t_plan"),
  capability("get_document", 33, "t_docs"),
  capability("update_document", 9, "t_docs"),
  capability("get_brain", 9, "t_brain"),
  capability("resolve_assets", 1, null),
  capability("whoami", 1, null),
];
const TASKS = [
  task("t_comment", 94, ["update_task", "add_comment"], "chart-1"),
  task("t_sync", 63, ["sync_session", "add_comment"], "chart-5"),
  task("t_new", 56, ["create_task", "add_comment"], "chart-4"),
  task("t_brain", 51, ["entity_lookup", "sync_session"]),
  task("t_edit", 50, ["create_task", "update_task"]),
  task("t_docs", 34, ["get_document", "update_document"]),
  task("t_push", 32, ["sync_session", "create_task"]),
  task("t_plan", 25, ["filter_tasks", "search_projects"]),
];
const MODEL: Pick<IntentMapModel, "capabilities" | "tasks"> = {
  capabilities: CAPABILITIES,
  tasks: TASKS,
};

function radii(ids: Iterable<string>, r = 8): Map<string, number> {
  return new Map([...ids].map((id) => [id, r]));
}

function globeOf(model: Pick<IntentMapModel, "capabilities" | "tasks">) {
  const { homes } = toolHomes(model);
  const globe = globeLayout(
    homes.map(
      (home): GlobeHome => ({ id: home.id, members: home.members, ring: home.kind === "other" }),
    ),
    new Map(model.capabilities.map((item) => [item.id, 5 + Math.sqrt(item.calls)])),
  );
  return { homes, globe };
}

test("every tool has exactly one home: its task, Shared when many tasks run it, Other when none does", () => {
  const { homes, homeOf } = toolHomes(MODEL);
  assert.equal(homeOf.size, CAPABILITIES.length);
  const members = homes.flatMap((home) => home.members);
  assert.equal(members.length, CAPABILITIES.length, "no tool sits in two homes");
  assert.deepEqual(new Set(members), new Set(CAPABILITIES.map((item) => item.id)));
  // add_comment is a step of three tasks, sync_session of three, create_task of three.
  assert.equal(SHARED_FROM_TASKS, 3);
  assert.deepEqual(homes[0], {
    id: SHARED_HOME,
    kind: "shared",
    task: null,
    name: "Shared",
    slot: null,
    members: ["tool:sync_session", "tool:add_comment", "tool:create_task"],
  });
  assert.equal(
    homeOf.get("tool:update_task"),
    "task:t_edit",
    "two tasks is not many: its main task keeps it",
  );
  assert.equal(homeOf.get("tool:resolve_assets"), OTHER_HOME);
  assert.deepEqual(
    homes.at(-1)!.members,
    ["tool:resolve_assets", "tool:whoami"],
    "Other comes last",
  );
  const plan = homes.find((home) => home.id === "task:t_plan")!;
  assert.deepEqual(
    plan.members,
    ["tool:filter_tasks", "tool:search_projects"],
    "a task's steps in order",
  );
  assert.equal(plan.name, "Task t_plan");
  assert.deepEqual(
    homes.map((home) => home.id),
    ["shared", "task:t_brain", "task:t_docs", "task:t_plan", "task:t_edit", "other"],
    "Shared first, then the homes with the most tools, busier tasks first on a tie",
  );
});

test("a task in a reading's colors keeps its color; a fourth task is neutral", () => {
  const { homes } = toolHomes({
    capabilities: [capability("a", 10, "t1"), capability("b", 9, "t4")],
    tasks: [task("t1", 90, ["a"], "chart-1"), task("t4", 10, ["b"])],
  });
  assert.deepEqual(
    homes.map((home) => [home.id, home.slot]),
    [
      ["task:t1", "chart-1"],
      ["task:t4", null],
    ],
  );
});

test("without any task, the tools that run together are the homes and the hubs are Shared", () => {
  const capabilities = [
    capability("a", 10, null),
    capability("b", 9, null),
    capability("c", 3, null),
  ].map((item) => ({ ...item, task: undefined }));
  const model: IntentMapModel = {
    asks: [
      {
        id: "i1",
        label: "x",
        volume: 5,
        phrasings: 1,
        firstTry: null,
        rankedByGraph: 0,
        problem: null,
      },
    ],
    capabilities,
    links: [
      { ask: "i1", capability: "tool:a", weight: 5, share: 0.5 },
      { ask: "i1", capability: "tool:b", weight: 5, share: 0.5 },
    ],
    hidden: null,
  };
  const network = buildToolNetwork({ model });
  const { homes, homeOf } = toolHomes(model, network);
  assert.equal(homes[0]!.kind, "group");
  assert.equal(homes[0]!.name, "Run together");
  assert.equal(homeOf.get("tool:c"), OTHER_HOME, "a tool no intent links sits on the ring");
});

test("the globe is the same every time, whatever order the tools arrive in", () => {
  const first = globeOf(MODEL).globe;
  const shuffled = globeOf({
    capabilities: [...CAPABILITIES].reverse(),
    tasks: [...TASKS].reverse(),
  }).globe;
  assert.deepEqual([...first.marks].sort(), [...shuffled.marks].sort());
  assert.deepEqual([...first.regions].sort(), [...shuffled.regions].sort());
  assert.deepEqual(first.disc, shuffled.disc);
  assert.deepEqual(first.ring, shuffled.ring);
});

test("every tool sits inside its home's region, regions never overlap, and all of them fit the disc", () => {
  const { homes, globe } = globeOf(MODEL);
  assert.equal(globe.marks.size, CAPABILITIES.length, "every tool is placed");
  const regions = [...globe.regions];
  for (const home of homes) {
    if (home.kind === "other") continue;
    const region = globe.regions.get(home.id)!;
    for (const id of home.members) {
      const mark = globe.marks.get(id)!;
      assert.ok(
        Math.hypot(mark.x - region.x, mark.y - region.y) + mark.r <= region.r,
        `${id} is inside ${home.id}`,
      );
    }
    assert.ok(
      Math.hypot(region.x - globe.disc.x, region.y - globe.disc.y) + region.r <=
        globe.disc.r - DISC_PAD + 0.5,
      `${home.id} is inside the disc`,
    );
  }
  for (let i = 0; i < regions.length; i += 1) {
    for (let j = i + 1; j < regions.length; j += 1) {
      const [, a] = regions[i]!;
      const [, b] = regions[j]!;
      assert.ok(
        Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r + REGION_GAP - 0.5,
        `${regions[i]![0]} and ${regions[j]![0]} keep apart`,
      );
    }
  }
});

test("the Shared home takes the middle and Other rings the disc, evenly, outside it", () => {
  const { globe } = globeOf(MODEL);
  const shared = globe.regions.get(SHARED_HOME)!;
  const others = [...globe.regions]
    .filter(([id]) => id !== SHARED_HOME)
    .map(([, region]) => Math.hypot(region.x, region.y));
  assert.ok(
    Math.hypot(shared.x, shared.y) <= Math.min(...others),
    "nothing sits nearer the middle than Shared",
  );
  assert.ok(globe.ring);
  for (const id of ["tool:resolve_assets", "tool:whoami"]) {
    const mark = globe.marks.get(id)!;
    assert.ok(Math.abs(Math.hypot(mark.x, mark.y) - globe.ring.r) < 0.5, `${id} is on the ring`);
    assert.ok(Math.hypot(mark.x, mark.y) - mark.r > globe.disc.r, `${id} is outside the disc`);
  }
  const [a, b] = ["tool:resolve_assets", "tool:whoami"].map((id) => globe.marks.get(id)!);
  assert.ok(
    Math.abs(a!.x + b!.x) < 0.5 && Math.abs(a!.y + b!.y) < 0.5,
    "two tools on the ring sit opposite each other",
  );
});

test("a region's tools keep their spacing: a short task stands in a column in step order, a long one on a spiral", () => {
  const column = arrangeRegion(["a", "b", "c"], radii(["a", "b", "c"]));
  const [a, b, c] = ["a", "b", "c"].map((id) => column.points.get(id)!);
  assert.equal(COLUMN_MAX, 3);
  assert.ok(
    a!.x === b!.x && b!.x === c!.x && a!.y < b!.y && b!.y < c!.y,
    "top to bottom, in order",
  );
  assert.equal(Math.round(b!.y - a!.y), 8 + 8 + TOOL_SPACING);
  const ids = Array.from({ length: 12 }, (_, index) => `t${index}`);
  const spiral = arrangeRegion(ids, radii(ids));
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const p = spiral.points.get(ids[i]!)!;
      const q = spiral.points.get(ids[j]!)!;
      assert.ok(
        Math.hypot(p.x - q.x, p.y - q.y) >= 16 + TOOL_SPACING - 0.01,
        `${ids[i]} and ${ids[j]} keep apart`,
      );
    }
  }
});

test("regions pack round from the middle outward, and the enclosing circle holds them all", () => {
  const circles = [40, 30, 30, 20, 20, 20, 10].map((r, index) => ({ id: `r${index}`, r }));
  const packed = packRegions(circles);
  assert.deepEqual(packed.get("r0"), { x: 0, y: 0 }, "the first sits in the middle");
  const second = packed.get("r1")!;
  assert.ok(Math.abs(second.x) < 1e-6 && second.y < 0, "the next goes straight above it");
  const placed = circles.map((circle) => ({ ...packed.get(circle.id)!, r: circle.r }));
  const disc = encloseCircles(placed);
  for (const circle of placed)
    assert.ok(Math.hypot(circle.x - disc.x, circle.y - disc.y) + circle.r <= disc.r + 1e-6);
  const area = placed.reduce((sum, circle) => sum + Math.PI * circle.r ** 2, 0);
  // The gaps keep room for names; still most of the disc is regions, never a scatter.
  assert.ok(area / (Math.PI * disc.r ** 2) > 0.33, "packed, not scattered");
});
