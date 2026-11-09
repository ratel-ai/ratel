import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BenchRow } from "@/components/console/playground/BenchRow";
import type { BenchEntry, BenchSaveAffordance } from "@/lib/synthesis/playground/bench-view";
import { BENCH_ENTRY_DEFAULTS } from "@/lib/synthesis/playground/test-support";

/**
 * What the bench SAYS about the two descriptions.
 *
 * The ranking fix is invisible unless the row names which text produced the
 * match and which one the agent is handed, so this is the half that makes the
 * correctness work legible. The rule it pins down is the awkward one: label
 * both when they differ, and print exactly one paragraph when they do not —
 * which is most of the time, because ingest copies one into the other.
 */

const noop = () => undefined;
const SKILL_SAVE: BenchSaveAffordance = { kind: "skill", label: "Save to catalog" };

function render(
  entry: Partial<BenchEntry> & { id: string },
  over: {
    saveAffordance?: BenchSaveAffordance;
    editing?: boolean;
    /** The STORED match text the editor diffs against. */
    saved?: string;
  } = {},
): string {
  const row: BenchEntry = {
    ...BENCH_ENTRY_DEFAULTS,
    kind: "tool",
    description: "d",
    edited: false,
    rank: null,
    calls: null,
    hasDefinition: true,
    status: null,
    ...entry,
  };
  // Mirrors `buildToolEntries`: a runtime row is what makes a tool managed. A
  // fixture that set `entryId` and left provenance at the default would be a
  // state the loader cannot produce, and would test nothing real.
  if (entry.provenance === undefined && row.kind === "tool") {
    row.provenance = row.entryId === null ? "observed" : "managed";
  }
  return renderToStaticMarkup(
    createElement(BenchRow, {
      entry: row,
      open: true,
      editing: over.editing ?? false,
      onToggle: noop,
      onEdit: noop,
      onCancelEdit: noop,
      saved: over.saved ?? row.description,
      tags: null,
      onCommit: noop,
      onRevert: noop,
      onSaveToCatalog:
        (over.saveAffordance ?? { kind: "blocked" }).kind === "blocked" ? null : noop,
      saveAffordance: over.saveAffordance ?? {
        kind: "blocked",
        reason: "Test only.",
      },
      saving: false,
    }),
  );
}

test("the decided vocabulary is what ships, not a third phrasing", () => {
  const html = render({
    id: "calendar_create",
    description: "schedule a meeting",
    agentDescription: "Persists an ICS entity.",
    searchableDescriptionSource: "runtime",
    entryId: "calendar.create",
  });
  // CAT-1 settled on this pair and explicitly ruled out the alternatives.
  assert.match(html, /Searchable description/);
  assert.match(html, /Agent description/);
  assert.doesNotMatch(html, /Retrieval description|Search text|Indexed description/);
});

test("a row whose two descriptions differ labels each one", () => {
  const html = render({
    id: "calendar_create",
    description: "schedule a meeting",
    agentDescription: "Persists an ICS entity to the organizer backend.",
    searchableDescriptionSource: "runtime",
    entryId: "calendar.create",
  });

  assert.match(html, /Searchable description/);
  assert.match(html, /Runtime default/);
  assert.match(html, /schedule a meeting/);
  assert.match(html, /Agent description/);
  assert.match(html, /Persists an ICS entity/);
  // Two glyphs, one per role, from the same set the tools catalog uses.
  assert.match(html, /data-catalog-role="searchable"/);
  assert.match(html, /data-catalog-role="agent"/);
});

test("a Ratel override is named as one, so its owner is never in doubt", () => {
  const html = render({
    id: "calendar_create",
    description: "reserve a conference room",
    agentDescription: "Persists an ICS entity.",
    searchableDescriptionSource: "override",
    entryId: "calendar.create",
  });
  assert.match(html, /Searchable description/);
  assert.match(html, /Ratel override/);
  assert.doesNotMatch(html, /Runtime default/);
});

test("identical descriptions are said once, never printed twice", () => {
  const html = render({
    id: "ripgrep",
    description: "Search the repository.",
    agentDescription: null,
    searchableDescriptionSource: "runtime",
    entryId: "ripgrep",
  });

  // One merged block carrying BOTH role icons, rather than the paragraph twice.
  assert.match(html, /data-catalog-descriptions="identical"/);
  assert.match(html, /Searchable and agent description/);
  assert.match(html, /Same text used for both/);
  assert.equal(
    html.split("Search the repository.").length - 1,
    1,
    "the paragraph appears exactly once",
  );
});

test("a capability with one description still says which field that is", () => {
  // This assertion used to run the other way — no label at all when the two
  // texts coincide — and that WAS the bug: on a local project every tool looks
  // like this, so the surface said nothing precisely where nobody could guess.
  // One text still has a name; what it does not have is a second one.
  const html = render({
    id: "undescribed_tool",
    description: "Search the repository.",
    agentDescription: null,
    searchableDescriptionSource: "description",
  });

  // One text, one block, both roles named on it — rather than the old
  // behavior of saying nothing at all.
  assert.match(html, /data-catalog-descriptions="identical"/);
  assert.match(html, /Searchable and agent description/);
  assert.match(html, /Same text used for both/);
});

test("an unsavable row states the reason rather than offering a dead button", () => {
  const html = render(
    {
      id: "ripgrep",
      description: "Search the repository.",
      edited: true,
      entryId: null,
    },
    {
      saveAffordance: {
        kind: "blocked",
        reason: "Test only. Register this tool through the Ratel runtime.",
      },
    },
  );

  assert.match(html, /Register this tool through the Ratel runtime/);
  assert.doesNotMatch(html, /Save searchable description/);
});

test("a skill row still offers the catalog save it always had", () => {
  const html = renderToStaticMarkup(
    createElement(BenchRow, {
      entry: {
        ...BENCH_ENTRY_DEFAULTS,
        id: "triage-incident",
        kind: "skill",
        description: "page the on-call",
        edited: true,
        rank: null,
        calls: null,
        hasDefinition: true,
        status: "published",
      },
      open: true,
      editing: false,
      onToggle: noop,
      onEdit: noop,
      onCancelEdit: noop,
      saved: "escalate an outage",
      tags: [],
      onCommit: noop,
      onRevert: noop,
      onSaveToCatalog: noop,
      saveAffordance: SKILL_SAVE,
      saving: false,
    }),
  );
  assert.match(html, /Save to catalog/);
});

test("a tool row shows observed tokens and cost, marked as estimates", () => {
  const html = render({
    id: "ripgrep",
    description: "Search the repository.",
    calls: 12,
    tokens: 1200,
    tokensProvenance: "otel",
    costUsd: 0.42,
    costProvenance: "otel",
  });

  assert.match(html, /1,200/);
  assert.match(html, /\$0\.42/);
  // The approximation marker, so an OTel reconstruction never reads as billed.
  assert.match(html, /data-provenance="otel"/);
});

test("a tool telemetry never priced shows an em dash, not a confident zero", () => {
  const html = render({
    id: "never_called",
    description: "Declared but unused.",
    calls: 0,
    tokens: 0,
    tokensProvenance: "absent",
    costUsd: 0,
    costProvenance: "absent",
  });

  assert.match(html, /data-provenance="absent"/);
  assert.doesNotMatch(html, /\$0\.00/);
});

/* — The editor says what it is editing ——————————————————————————————————————— */

/**
 * The defect Kayra hit: open Edit on a local project and you get one unlabelled
 * box with no way to tell which of the two descriptions you are changing.
 *
 * The cause was a rule borrowed from the read view — "when the two texts are
 * identical, do not print them twice" — applied where it does not hold. In the
 * editor the question is not "are these the same?" but "which field is this?",
 * and that has an answer even when only one field exists. These tests pin the
 * distinction so the label cannot quietly become conditional again.
 */

test("the editor names the field even when there is only one description", () => {
  const html = render(
    {
      id: "ripgrep",
      description: "Search the repository.",
      agentDescription: null,
      searchableDescriptionSource: "description",
      entryId: null,
    },
    { editing: true },
  );

  // One text, both roles named on it — rather than the old behavior of saying
  // nothing at all when the two happened to coincide.
  assert.match(html, /Searchable and agent description/);
  assert.match(html, /Same text used for both/);
  assert.match(html, /data-catalog-role="searchable"/);
  assert.match(html, /data-catalog-role="agent"/);
});

test("a managed entry keeps the agent description in view while you type", () => {
  // You cannot differentiate one text from another with the other off-screen.
  const html = render(
    {
      id: "calendar_create",
      description: "schedule a meeting",
      agentDescription: "Persists an ICS entity to the organizer backend.",
      searchableDescriptionSource: "runtime",
      entryId: "calendar.create",
    },
    { editing: true },
  );

  assert.match(html, /Searchable description/);
  assert.match(html, /Agent description/);
  assert.match(html, /Persists an ICS entity/);
  // And the help that spells out all three layers, for the reader who has not
  // yet built the model from the labels alone.
  assert.match(html, /How the searchable description is resolved/);
});

test("a savable row offers testing and saving as two different verbs", () => {
  const html = render(
    {
      id: "calendar_create",
      description: "reserve a room",
      searchableDescriptionSource: "override",
      entryId: "calendar.create",
    },
    {
      editing: true,
      saveAffordance: {
        kind: "searchable-description",
        label: "Save searchable description",
      },
    },
  );

  // Named for what each does, and side by side, so "which of these writes
  // anything?" is answerable without hunting for the other button.
  assert.match(html, /Test without saving/);
  // The consequence rides on the control, not only in a tooltip nobody can
  // reach by keyboard.
  assert.match(html, /aria-label="Test without saving\.[^"]*nothing is written to the catalog/);
  assert.match(html, />Save to catalog</, "and the write sits right beside it");
});

test("an unsavable row offers only the test, and says why", () => {
  const html = render(
    {
      id: "ripgrep",
      description: "a different wording",
      searchableDescriptionSource: "description",
      entryId: null,
    },
    {
      editing: true,
      saveAffordance: {
        kind: "blocked",
        reason: "Test only. Register this tool through the Ratel runtime.",
      },
    },
  );

  assert.match(html, /Test without saving/);
  assert.match(html, /Register this tool through the Ratel runtime/);
  // Nothing that suggests a write is possible here.
  assert.doesNotMatch(html, /Override in Ratel|Reset to runtime default/);
});

test("the agent description grows out of the merged block rather than snapping in", () => {
  const html = render(
    {
      id: "calendar_create",
      description: "schedule a meeting",
      agentDescription: "Persists an ICS entity.",
      searchableDescriptionSource: "runtime",
      entryId: "calendar.create",
      runtimeDefault: "schedule a meeting",
    },
    {
      editing: true,
      saveAffordance: { kind: "searchable-description", label: "Save" },
    },
  );
  // The separation is the thing to notice; appearing instantly read as a jump.
  assert.match(html, /description-split-enter/);
});

/* — The three layers, made legible ——————————————————————————————————————————— */

/**
 * Kayra, on the previous revision: "I feel like I am editing the default runtime
 * version, which I cannot. I can only override it with cloud."
 *
 * He was reading the UI correctly — it opened a box over the runtime's text and
 * said nothing about ownership. These pin the model the surface now teaches:
 * the runtime's copy is shown, taking it over is a deliberate act, and clearing
 * the field hands it back.
 */

test("the pencil is the only gate; editing opens straight into the override", () => {
  // Edit, then a second "Override in Cloud" before any field appeared, was two
  // gates for one intention. The row's own Edit control already means "I want
  // to change this", so the field opens — and the badge names what the box now
  // holds, which is a Cloud override, not the runtime's text.
  const html = render(
    {
      id: "calendar_create",
      description: "schedule a meeting",
      agentDescription: "Persists an ICS entity.",
      searchableDescriptionSource: "runtime",
      entryId: "calendar.create",
      runtimeDefault: "schedule a meeting",
    },
    {
      editing: true,
      saveAffordance: { kind: "searchable-description", label: "Save" },
    },
  );

  assert.match(html, /<textarea/);
  assert.doesNotMatch(html, /Override in Ratel/);
  assert.match(html, /Ratel override/);
  // The runtime layer stays named, and stays reachable.
  assert.match(html, /Reset to runtime default/);
});

test("a row Ratel cannot write gets the field but none of the override machinery", () => {
  const html = render(
    {
      id: "ripgrep",
      description: "Search the repository.",
      agentDescription: null,
      searchableDescriptionSource: "description",
      entryId: null,
      runtimeDefault: "Search the repository.",
    },
    {
      editing: true,
      saveAffordance: {
        kind: "blocked",
        reason: "Test only. Register this tool through the Ratel runtime.",
      },
    },
  );

  assert.match(html, /<textarea/, "a what-if is still worth typing");
  assert.match(html, /Test without saving/);
  assert.match(html, /Register this tool through the Ratel runtime/);
  // None of this row can be persisted, so none of it should be offered.
  assert.doesNotMatch(html, /Reset to runtime default|Override in Ratel/);
  assert.doesNotMatch(html, /removes the Ratel override/);
});

test("an entry Ratel already owns opens straight into the field", () => {
  const html = render(
    {
      id: "calendar_create",
      description: "reserve a conference room",
      agentDescription: "Persists an ICS entity.",
      searchableDescriptionSource: "override",
      entryId: "calendar.create",
      runtimeDefault: "schedule a meeting",
    },
    {
      editing: true,
      saved: "schedule a meeting",
      saveAffordance: { kind: "searchable-description", label: "Save" },
    },
  );

  assert.match(html, /Ratel override/);
  assert.match(html, /<textarea/);
  // The question the labels alone could not answer.
  assert.match(html, /Clearing the field and saving removes the Ratel override/);
  assert.match(html, /Reset to runtime default/);
  assert.match(html, /Match the agent description/);
});

test("no before/after block: the field and the agent panel already say it", () => {
  const html = render(
    {
      id: "calendar_create",
      description: "reserve a conference room",
      agentDescription: "Persists an ICS entity.",
      searchableDescriptionSource: "override",
      entryId: "calendar.create",
      runtimeDefault: "schedule a meeting",
    },
    {
      editing: true,
      saved: "schedule a meeting",
      saveAffordance: { kind: "searchable-description", label: "Save" },
    },
  );
  assert.doesNotMatch(html, /What this changes/);
});

test("a conditional action slides into the row rather than popping into it", () => {
  // "Match the agent description" only exists while the two texts differ, so it
  // arrives and leaves in a row the reader is already looking at. Appearing
  // instantly read as the row twitching.
  const diverged = render(
    {
      id: "calendar_create",
      description: "reserve a conference room",
      agentDescription: "Persists an ICS entity.",
      searchableDescriptionSource: "override",
      entryId: "calendar.create",
      runtimeDefault: "schedule a meeting",
    },
    {
      editing: true,
      saved: "schedule a meeting",
      saveAffordance: { kind: "searchable-description", label: "Save" },
    },
  );
  assert.match(diverged, /Match the agent description/);
  // Both conditional actions are wrapped: one motion vocabulary, not two.
  assert.equal((diverged.match(/action-reveal-enter/g) ?? []).length, 2);

  // With one text there is nothing to match against, so the action is absent —
  // not merely animated to zero width, which would leave a gap in the row.
  const identical = render(
    {
      id: "ripgrep",
      description: "Search the repository.",
      agentDescription: null,
      searchableDescriptionSource: "runtime",
      entryId: "ripgrep",
      runtimeDefault: "Search the repository.",
    },
    {
      editing: true,
      saveAffordance: { kind: "searchable-description", label: "Save" },
    },
  );
  assert.doesNotMatch(identical, /Match the agent description/);
});

/* — Which button is the safe one ————————————————————————————————————————————— */

/**
 * The Playground is a scratchpad. Writing to the catalog is the only action on
 * it that leaves the browser, so it is the only one that should look like a
 * commitment — and the affirmative styling belongs to the action people came
 * here to take, which is the one that changes nothing.
 */
test("the safe action is the affirmative one; the write is not", () => {
  const html = render(
    {
      id: "calendar_create",
      description: "reserve a conference room",
      agentDescription: "Persists an ICS entity.",
      searchableDescriptionSource: "override",
      entryId: "calendar.create",
      runtimeDefault: "schedule a meeting",
    },
    {
      editing: true,
      saved: "schedule a meeting",
      saveAffordance: { kind: "searchable-description", label: "Save" },
    },
  );

  const buttons = [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>([^<]*)</g)];
  const styleOf = (label: string) => buttons.find((m) => m[2].trim() === label)?.[1] ?? "";

  assert.match(styleOf("Test without saving"), /bg-cream/, "the CTA");
  assert.doesNotMatch(styleOf("Save to catalog"), /bg-cream/);
  assert.match(styleOf("Save to catalog"), /border-coral/, "muted, not loud");
  // Named for its destination, so "save" cannot be read as "save my draft".
  assert.match(html, /Save to catalog/);
});

test("the write asks first: the question is not on screen until it is armed", () => {
  const html = render(
    {
      id: "calendar_create",
      description: "reserve a conference room",
      searchableDescriptionSource: "override",
      entryId: "calendar.create",
      runtimeDefault: "schedule a meeting",
    },
    {
      editing: true,
      saved: "schedule a meeting",
      saveAffordance: { kind: "searchable-description", label: "Save" },
    },
  );
  // Two steps, so the first click cannot be the one that writes. The armed
  // state itself needs a click, which this renderer cannot make — the button's
  // presence, the absent question, and the absent dialog are what it can pin.
  assert.doesNotMatch(html, /Write this to the project catalog\?/);
  assert.doesNotMatch(html, /role="dialog"/);
  assert.match(html, /Save to catalog/);
});

test("the write and the safe action sit at opposite ends of the row", () => {
  // Adjacent, they were two similar buttons and one of them left the browser.
  // The trailing edge is where the eye lands, so the safe default takes it.
  const order = (html: string) =>
    [...html.matchAll(/<button[^>]*>([^<]{3,})</g)].map((m) => m[1].trim());

  const managed = order(
    render(
      {
        id: "calendar_create",
        description: "reserve a conference room",
        agentDescription: "Persists an ICS entity.",
        searchableDescriptionSource: "override",
        entryId: "calendar.create",
        runtimeDefault: "schedule a meeting",
      },
      {
        editing: true,
        saved: "schedule a meeting",
        saveAffordance: { kind: "searchable-description", label: "Save" },
      },
    ),
  );

  assert.equal(managed[0], "Save to catalog", "the write leads, alone");
  assert.equal(managed[managed.length - 1], "Test without saving", "the safe action trails");
});
