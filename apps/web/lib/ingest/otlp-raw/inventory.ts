import { decodeOtlp } from "@/lib/ingest/otlp/decode";
import { decodeOtlpLogs } from "@/lib/ingest/otlp/decode-logs";
import type { AttrMap } from "@/lib/ingest/otlp/types";
import type { OtlpRawSignal } from "./domain";

/**
 * The attribute key inventory of raw OTLP exports: per instrumentation scope,
 * which span names, resource keys, attribute keys and event names a project
 * sends, each with a count. It reads keys and names only, never a value, so it
 * is safe to print for any customer.
 */
export interface KeyInventory {
  exports: number;
  spans: number;
  logRecords: number;
  undecodable: number;
  scopes: ScopeKeyInventory[];
}

export interface ScopeKeyInventory {
  scope: string;
  spanNames: KeyCount[];
  resourceKeys: KeyCount[];
  spanAttributeKeys: KeyCount[];
  spanEventNames: KeyCount[];
  spanEventAttributeKeys: KeyCount[];
  logEventNames: KeyCount[];
  logAttributeKeys: KeyCount[];
}

export interface KeyCount {
  key: string;
  count: number;
}

type Section = Exclude<keyof ScopeKeyInventory, "scope">;
type Counters = Record<Section, Map<string, number>>;

const SECTIONS: Section[] = [
  "spanNames",
  "resourceKeys",
  "spanAttributeKeys",
  "spanEventNames",
  "spanEventAttributeKeys",
  "logEventNames",
  "logAttributeKeys",
];
const NO_SCOPE = "(no scope)";
const SECTION_LABELS: Record<Section, string> = {
  spanNames: "span names",
  resourceKeys: "resource keys",
  spanAttributeKeys: "span attribute keys",
  spanEventNames: "span event names",
  spanEventAttributeKeys: "span event attribute keys",
  logEventNames: "log event names",
  logAttributeKeys: "log attribute keys",
};

export function createKeyInventory() {
  const scopes = new Map<string, Counters>();
  const totals = { exports: 0, spans: 0, logRecords: 0, undecodable: 0 };

  function counters(scopeName: string | null): Counters {
    const scope = scopeName || NO_SCOPE;
    let found = scopes.get(scope);
    if (!found) {
      found = Object.fromEntries(SECTIONS.map((s) => [s, new Map()])) as Counters;
      scopes.set(scope, found);
    }
    return found;
  }

  return {
    /** Count one inflated export body. A body that does not decode is counted as undecodable. */
    add(signal: OtlpRawSignal, contentType: string, body: Uint8Array): void {
      totals.exports += 1;
      try {
        if (signal === "traces") {
          for (const span of decodeOtlp(contentType, body)) {
            const c = counters(span.scopeName);
            totals.spans += 1;
            bump(c.spanNames, span.name);
            bumpKeys(c.resourceKeys, span.resourceAttributes);
            bumpKeys(c.spanAttributeKeys, span.attributes);
            for (const event of span.events) {
              bump(c.spanEventNames, event.name);
              bumpKeys(c.spanEventAttributeKeys, event.attributes);
            }
          }
        } else {
          for (const record of decodeOtlpLogs(contentType, body)) {
            const c = counters(record.scopeName);
            totals.logRecords += 1;
            bump(c.logEventNames, record.eventName);
            bumpKeys(c.resourceKeys, record.resourceAttributes);
            bumpKeys(c.logAttributeKeys, record.attributes);
          }
        }
      } catch {
        totals.undecodable += 1;
      }
    },
    result(): KeyInventory {
      return {
        ...totals,
        scopes: [...scopes.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([scope, c]) => ({
            scope,
            ...(Object.fromEntries(SECTIONS.map((s) => [s, ranked(c[s])])) as Record<
              Section,
              KeyCount[]
            >),
          })),
      };
    },
  };
}

/** A plain-text printout of the inventory: scope headings, then each non-empty section. */
export function formatKeyInventory(inventory: KeyInventory): string {
  const lines = [
    `exports ${inventory.exports} · spans ${inventory.spans} · log records ${inventory.logRecords}` +
      (inventory.undecodable > 0 ? ` · undecodable ${inventory.undecodable}` : ""),
  ];
  for (const scope of inventory.scopes) {
    lines.push("", `scope ${scope.scope}`);
    for (const section of SECTIONS) {
      const entries = scope[section];
      if (entries.length === 0) continue;
      lines.push(`  ${SECTION_LABELS[section]}`);
      const width = Math.max(...entries.map((e) => e.key.length));
      for (const { key, count } of entries) lines.push(`    ${key.padEnd(width)}  ${count}`);
    }
  }
  return lines.join("\n");
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function bumpKeys(counts: Map<string, number>, attributes: AttrMap): void {
  for (const key of Object.keys(attributes)) bump(counts, key);
}

function ranked(counts: Map<string, number>): KeyCount[] {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
