import type { TaskColorSlot } from "@ratel/design-system/task-colors";
import {
  FLOW_STEPS,
  type FlowStats,
  flowTaskId,
  flowToolId,
  NEXT_OTHER,
  NEXT_RETRY,
} from "@/lib/readings/topics/types";
import { round } from "@/lib/views/health/flow-route";
import { mostlyUnanswered } from "@/lib/views/intents/topics-view";

/**
 * The Flows drawing: one column per ask of a conversation (the 1st ask to the
 * 4th, then "Then"), a chip per intent (or task, or tool) at each, and ribbons
 * between chips as thick as the conversations they carry. Conversations that
 * stop flow into the next column's "Ended" chip; ones that go on past the last
 * step into "Went on". Every chip is one height and every ribbon runs level out
 * of a chip and into the next, swinging only in the gap, so no ribbon crosses
 * any text.
 *
 * Pure and deterministic, so it lays out the same on the server and in the
 * browser. Chip ids are `<step>:<key>`: topic ids and fixed words, never names.
 */

export const FLOW_GEOMETRY = {
  columnWidth: 196,
  /** The last column holds only Ended and Went on: narrower. */
  thenWidth: 112,
  gap: 48,
  titleHeight: 28,
  chipHeight: 52,
  chipGap: 8,
  endedHeight: 34,
  endedGap: 16,
  /** Ribbon ends stay this far inside a chip's top and bottom. */
  inset: 8,
  endedInset: 6,
  minBand: 1.5,
  /** The thickest one conversation's ribbon gets, on a sparse flow. */
  maxScale: 8,
} as const;

export type FlowChipKind = "topic" | "task" | "tool" | "retry" | "other" | "ended" | "went_on";

export const FLOW_ENDED = "ended";
export const FLOW_WENT_ON = "went_on";

export interface FlowChip {
  id: string;
  /** 1-based column; the column after the last step is `FLOW_STEPS + 1` or less. */
  position: number;
  key: string;
  kind: FlowChipKind;
  label: string;
  sessions: number;
  /** Of the conversations at this step (for Ended and Went on: of those at the step before). */
  share: number;
  unanswered: number;
  mostlyUnanswered: boolean;
  /** The topic's main task color. */
  slot: TaskColorSlot | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FlowRibbon {
  id: string;
  from: string;
  to: string;
  sessions: number;
  /** Into Ended or Went on. */
  terminal: boolean;
  path: string;
}

export interface FlowColumnView {
  position: number;
  title: string;
  sessions: number;
  x: number;
}

export interface FlowLayout {
  width: number;
  height: number;
  columns: FlowColumnView[];
  chips: FlowChip[];
  ribbons: FlowRibbon[];
}

const G = FLOW_GEOMETRY;
const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

const ORDINALS = ["1st", "2nd", "3rd"] as const;

/**
 * A column's name: which ask of a conversation it holds ("1st ask", "2nd
 * ask"). Not "Step": a task's Steps are its tools in order.
 */
export function askOrdinal(position: number): string {
  return `${ORDINALS[position - 1] ?? `${position}th`} ask`;
}

function chipKind(key: string): FlowChipKind {
  if (key === NEXT_RETRY) return "retry";
  if (key === NEXT_OTHER) return "other";
  if (flowTaskId(key) !== null) return "task";
  if (flowToolId(key) !== null) return "tool";
  return "topic";
}

function chipLabel(
  kind: FlowChipKind,
  key: string,
  topics: ReadonlyMap<string, { name: string }>,
): string {
  if (kind === "retry") return "Asked again";
  if (kind === "other") return "Other";
  if (kind === "ended") return "Ended";
  if (kind === "went_on") return "Went on";
  if (kind === "tool") return flowToolId(key) ?? "A tool";
  return topics.get(key)?.name ?? (kind === "task" ? "A task" : "An intent");
}

/**
 * A ribbon's filled band, from a port on one chip's right edge to a port on
 * the next one's left edge, `t0` thick where it leaves and `t1` where it
 * arrives (thinner into a crowded Ended chip).
 */
export function bandPath(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  t0: number,
  t1: number = t0,
): string {
  const f = (value: number) => String(round(value));
  const mid = (x0 + x1) / 2;
  return (
    `M${f(x0)} ${f(y0)} C${f(mid)} ${f(y0)} ${f(mid)} ${f(y1)} ${f(x1)} ${f(y1)}` +
    ` L${f(x1)} ${f(y1 + t1)} C${f(mid)} ${f(y1 + t1)} ${f(mid)} ${f(y0 + t0)} ${f(x0)} ${f(y0 + t0)} Z`
  );
}

export function layoutFlow(
  stats: FlowStats,
  topics: ReadonlyMap<string, { name: string; slot: TaskColorSlot | null }>,
): FlowLayout | null {
  if (stats.columns.length === 0) return null;
  const chips: FlowChip[] = [];
  const columns: FlowColumnView[] = [];
  const heights: number[] = [];
  const last = stats.columns.at(-1)!;
  const x = (position: number) => (position - 1) * (G.columnWidth + G.gap);

  stats.columns.forEach((column, index) => {
    let y = G.titleHeight;
    for (const node of column.nodes) {
      const kind = chipKind(node.key);
      chips.push({
        id: `${column.position}:${node.key}`,
        position: column.position,
        key: node.key,
        kind,
        label: chipLabel(kind, node.key, topics),
        sessions: node.sessions,
        share: ratio(node.sessions, column.sessions),
        unanswered: node.unanswered,
        mostlyUnanswered: mostlyUnanswered(node.unanswered, node.sessions),
        slot: kind === "topic" || kind === "task" ? (topics.get(node.key)?.slot ?? null) : null,
        x: x(column.position),
        y,
        w: G.columnWidth,
        h: G.chipHeight,
      });
      y += G.chipHeight + G.chipGap;
    }
    const before = stats.columns[index - 1];
    if (before && before.ended > 0) {
      y += G.endedGap - G.chipGap;
      chips.push(
        terminal(FLOW_ENDED, column.position, before.ended, before.sessions, x(column.position), y),
      );
      y += G.endedHeight + G.chipGap;
    }
    columns.push({
      position: column.position,
      title: askOrdinal(column.position),
      sessions: column.sessions,
      x: x(column.position),
    });
    heights.push(y - G.chipGap);
  });

  // After the last step: who ended there, and who went on past the steps drawn.
  const then = last.position + 1;
  const wentOn = last.position >= FLOW_STEPS ? stats.wentOn : 0;
  if (last.ended > 0 || wentOn > 0) {
    let y = G.titleHeight;
    if (last.ended > 0) {
      chips.push(terminal(FLOW_ENDED, then, last.ended, last.sessions, x(then), y, G.thenWidth));
      y += G.endedHeight + G.chipGap;
    }
    if (wentOn > 0) {
      chips.push(terminal(FLOW_WENT_ON, then, wentOn, last.sessions, x(then), y, G.thenWidth));
      y += G.endedHeight + G.chipGap;
    }
    columns.push({ position: then, title: "Then", sessions: last.ended + wentOn, x: x(then) });
    heights.push(y - G.chipGap);
  }

  const byId = new Map(chips.map((chip) => [chip.id, chip]));
  const links: { from: FlowChip; to: FlowChip; sessions: number }[] = [];
  for (const column of stats.columns) {
    for (const node of column.nodes) {
      const from = byId.get(`${column.position}:${node.key}`)!;
      for (const next of node.next) {
        const to = byId.get(`${column.position + 1}:${next.key}`);
        if (to && next.sessions > 0) links.push({ from, to, sessions: next.sessions });
      }
      const ended = byId.get(`${column.position + 1}:${FLOW_ENDED}`);
      if (ended && node.ended > 0) links.push({ from, to: ended, sessions: node.ended });
      if (column.position >= FLOW_STEPS) {
        const went =
          node.sessions - node.ended - node.next.reduce((sum, next) => sum + next.sessions, 0);
        const to = byId.get(`${column.position + 1}:${FLOW_WENT_ON}`);
        if (to && went > 0) links.push({ from, to, sessions: went });
      }
    }
  }

  const ribbons = placeRibbons(links, chips);
  const lastColumn = columns.at(-1)!;
  const width =
    x(lastColumn.position) + (lastColumn.title === "Then" ? G.thenWidth : G.columnWidth);
  return { width, height: Math.max(...heights, G.titleHeight), columns, chips, ribbons };
}

function terminal(
  key: typeof FLOW_ENDED | typeof FLOW_WENT_ON,
  position: number,
  sessions: number,
  of: number,
  x: number,
  y: number,
  w: number = G.columnWidth,
): FlowChip {
  const kind: FlowChipKind = key === FLOW_ENDED ? "ended" : "went_on";
  return {
    id: `${position}:${key}`,
    position,
    key,
    kind,
    label: chipLabel(kind, key, new Map()),
    sessions,
    share: ratio(sessions, of),
    unanswered: 0,
    mostlyUnanswered: false,
    slot: null,
    x,
    y,
    w,
    h: G.endedHeight,
  };
}

/**
 * Ribbons stacked on each chip's edge in the order of where they go (or come
 * from), so none cross on the way out or in, centred on the chip. One scale
 * for the whole drawing, set so the busiest topic chip's ribbons fit inside
 * it; an Ended or Went on chip gathers more than it can hold, so the ribbons
 * into it narrow along their swing to fit.
 */
function placeRibbons(
  links: readonly { from: FlowChip; to: FlowChip; sessions: number }[],
  chips: readonly FlowChip[],
): FlowRibbon[] {
  const inner = (chip: FlowChip) =>
    chip.h - 2 * (chip.kind === "ended" || chip.kind === "went_on" ? G.endedInset : G.inset);
  const outflow = new Map<string, number>();
  const inflow = new Map<string, number>();
  for (const link of links) {
    outflow.set(link.from.id, (outflow.get(link.from.id) ?? 0) + link.sessions);
    inflow.set(link.to.id, (inflow.get(link.to.id) ?? 0) + link.sessions);
  }
  const terminalChip = (chip: FlowChip) => chip.kind === "ended" || chip.kind === "went_on";
  let scale: number = G.maxScale;
  for (const chip of chips) {
    if (terminalChip(chip)) continue;
    const load = Math.max(outflow.get(chip.id) ?? 0, inflow.get(chip.id) ?? 0);
    if (load > 0) scale = Math.min(scale, inner(chip) / load);
  }
  const thickness = (sessions: number) => Math.max(G.minBand, sessions * scale);
  // Into a terminal chip, each ribbon arrives narrowed by the same factor, so together they fit it.
  const squeeze = new Map(
    chips.filter(terminalChip).map((chip) => {
      const total = links
        .filter((link) => link.to.id === chip.id)
        .reduce((sum, link) => sum + thickness(link.sessions), 0);
      return [chip.id, total > inner(chip) ? inner(chip) / total : 1] as const;
    }),
  );
  const arriving = (link: (typeof links)[number]) =>
    thickness(link.sessions) * (squeeze.get(link.to.id) ?? 1);
  const centre = (chip: FlowChip) => chip.y + chip.h / 2;
  const order = (a: FlowChip, b: FlowChip) => a.y - b.y || a.x - b.x;

  const outPort = new Map<string, number>();
  const inPort = new Map<string, number>();
  const stack = (
    chip: FlowChip,
    own: readonly { link: (typeof links)[number]; other: FlowChip }[],
    ports: Map<string, number>,
    width: (link: (typeof links)[number]) => number,
  ) => {
    const sorted = [...own].sort((a, b) => order(a.other, b.other));
    const total = sorted.reduce((sum, item) => sum + width(item.link), 0);
    let cursor = centre(chip) - total / 2;
    for (const item of sorted) {
      ports.set(`${item.link.from.id}>${item.link.to.id}`, cursor);
      cursor += width(item.link);
    }
  };
  for (const chip of chips) {
    stack(
      chip,
      links.filter((link) => link.from.id === chip.id).map((link) => ({ link, other: link.to })),
      outPort,
      (link) => thickness(link.sessions),
    );
    stack(
      chip,
      links.filter((link) => link.to.id === chip.id).map((link) => ({ link, other: link.from })),
      inPort,
      arriving,
    );
  }
  return links.map((link) => {
    const id = `${link.from.id}>${link.to.id}`;
    return {
      id,
      from: link.from.id,
      to: link.to.id,
      sessions: link.sessions,
      terminal: terminalChip(link.to),
      path: bandPath(
        link.from.x + link.from.w,
        outPort.get(id)!,
        link.to.x,
        inPort.get(id)!,
        thickness(link.sessions),
        arriving(link),
      ),
    };
  });
}

/** What lights with a chip: itself, the chips one ribbon away, and those ribbons. */
export function flowNeighbourhood(
  layout: Pick<FlowLayout, "ribbons">,
  chipId: string | null,
): { chips: Set<string>; ribbons: Set<string> } {
  const chips = new Set<string>();
  const ribbons = new Set<string>();
  if (!chipId) return { chips, ribbons };
  chips.add(chipId);
  for (const ribbon of layout.ribbons) {
    if (ribbon.from !== chipId && ribbon.to !== chipId) continue;
    ribbons.add(ribbon.id);
    chips.add(ribbon.from);
    chips.add(ribbon.to);
  }
  return { chips, ribbons };
}
