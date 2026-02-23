import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type {
  InspectorState,
  EventLogEntry,
  AgentifiedTool,
  ConnectionStatus,
} from "@agentified/fe-client";
import { useAgentified } from "./hook.js";

// ── Types ──────────────────────────────────────────────────────────────

export type InspectorPosition =
  | "bottom-right"
  | "bottom-left"
  | "top-right"
  | "top-left";

type Tab = "overview" | "agentified" | "tokens" | "events";

export interface InspectorProps {
  position?: InspectorPosition;
  defaultOpen?: boolean;
}

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "agentified", label: "Agentified" },
  { key: "tokens", label: "Tokens" },
  { key: "events", label: "Events" },
];

// ── Inspector ──────────────────────────────────────────────────────────

export function Inspector({ position = "bottom-right", defaultOpen = false }: InspectorProps) {
  const { state } = useAgentified();
  const [open, setOpen] = useState(defaultOpen);
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  if (!open) {
    return (
      <button
        data-testid="inspector-toggle"
        onClick={() => setOpen(true)}
        style={toggleStyle(position)}
        aria-label="Open Agentified Inspector"
      >
        <span style={S.toggleIcon}>◈</span>
      </button>
    );
  }

  return (
    <div data-testid="inspector-panel" style={panelStyle(position)}>
      <div style={S.header}>
        <div style={S.headerLeft}>
          <span style={S.headerDot(state.connection)} />
          <span style={S.headerTitle}>Agentified</span>
        </div>
        <button
          data-testid="inspector-close"
          onClick={() => setOpen(false)}
          style={S.closeBtn}
          aria-label="Close Inspector"
        >
          ✕
        </button>
      </div>

      <div style={S.tabs}>
        {TABS.map((t) => (
          <button
            key={t.key}
            data-testid={`tab-${t.key}`}
            onClick={() => setActiveTab(t.key)}
            style={tabStyle(t.key === activeTab)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={S.body}>
        {activeTab === "overview" && <OverviewTab state={state} />}
        {activeTab === "agentified" && <AgentifiedTab state={state} />}
        {activeTab === "tokens" && <TokensTab state={state} />}
        {activeTab === "events" && <EventsTab state={state} />}
      </div>
    </div>
  );
}

// ── Tab: Overview ──────────────────────────────────────────────────────

function OverviewTab({ state }: { state: InspectorState }) {
  const { connection, run, streaming } = state;

  return (
    <div>
      <Section title="Run">
        <Row label="Status" value={connectionLabel(connection)} />
        {run.runId && <Row label="Run ID" value={run.runId} mono />}
        {run.threadId && <Row label="Thread" value={run.threadId} mono />}
        {run.durationMs != null && <Row label="Duration" value={`${run.durationMs}ms`} />}
      </Section>

      <Section title="Streaming">
        <Row label="Messages" value={String(streaming.messageCount)} />
        <Row label="Tool Calls" value={String(streaming.toolCallCount)} />
        {streaming.timeToFirstTokenMs != null && (
          <Row label="TTFT" value={`${streaming.timeToFirstTokenMs}ms`} />
        )}
      </Section>
    </div>
  );
}

// ── Tab: Agentified ────────────────────────────────────────────────────

function AgentifiedTab({ state }: { state: InspectorState }) {
  const { agentified } = state;
  const lastPrefetch = agentified.prefetchResults[agentified.prefetchResults.length - 1];

  return (
    <div>
      {agentified.currentTools.length > 0 && (
        <Section title="Current Tools">
          {agentified.currentTools.map((tool, i) => (
            <ToolRow key={`${tool.name}-${i}`} tool={tool} />
          ))}
        </Section>
      )}

      {lastPrefetch && (
        <Section title="Last Prefetch">
          <Row label="Tools" value={String(lastPrefetch.tools.length)} />
          <Row label="Duration" value={`${lastPrefetch.durationMs}ms`} />
        </Section>
      )}

      {agentified.discoveries.length > 0 && (
        <Section title="Discoveries">
          {agentified.discoveries.map((d, i) => (
            <div key={i} style={S.discoveryItem}>
              <div style={S.discoveryQuery}>"{d.query}"</div>
              <div style={S.discoveryMeta}>
                {d.tools.length} tools · {d.durationMs}ms
              </div>
            </div>
          ))}
        </Section>
      )}

      {agentified.currentTools.length === 0 &&
        !lastPrefetch &&
        agentified.discoveries.length === 0 && (
          <div style={S.emptyState}>No Agentified interactions yet</div>
        )}
    </div>
  );
}

// ── Tab: Tokens ────────────────────────────────────────────────────────

function TokensTab({ state }: { state: InspectorState }) {
  const { tokens } = state;
  const total = tokens.input + tokens.output + tokens.cached + tokens.reasoning;

  return (
    <div>
      <Section title="Usage">
        <Row label="Input" value={formatNumber(tokens.input)} />
        <Row label="Output" value={formatNumber(tokens.output)} />
        <Row label="Cached" value={formatNumber(tokens.cached)} />
        <Row label="Reasoning" value={formatNumber(tokens.reasoning)} />
        <div style={S.totalRow}>
          <span>Total</span>
          <span style={S.totalValue}>{formatNumber(total)}</span>
        </div>
      </Section>

      {tokens.contextWindowPercent != null && (
        <Section title="Context Window">
          <div style={S.barOuter}>
            <div
              data-testid="context-bar"
              style={barFill(tokens.contextWindowPercent)}
            />
          </div>
          <div style={S.barLabel}>{tokens.contextWindowPercent.toFixed(1)}%</div>
        </Section>
      )}
    </div>
  );
}

// ── Tab: Events ────────────────────────────────────────────────────────

function EventsTab({ state }: { state: InspectorState }) {
  const listRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(state.events.length);

  useEffect(() => {
    if (state.events.length > prevLen.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    prevLen.current = state.events.length;
  }, [state.events.length]);

  return (
    <div ref={listRef} style={S.eventList} data-testid="event-list">
      {state.events.length === 0 && (
        <div style={S.emptyState}>No events yet</div>
      )}
      {state.events.map((entry, i) => (
        <EventRow key={i} entry={entry} />
      ))}
    </div>
  );
}

function EventRow({ entry }: { entry: EventLogEntry }) {
  const time = new Date(entry.timestamp).toLocaleTimeString();
  const eventType = "name" in entry.event
    ? (entry.event as { name: string }).name
    : entry.event.type;

  return (
    <div style={eventRowStyle(entry.isAgentified)} data-testid="event-row">
      <span style={S.eventTime}>{time}</span>
      <span style={S.eventType(entry.isAgentified)}>{eventType}</span>
    </div>
  );
}

// ── Shared Sub-components ──────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={S.section}>
      <div style={S.sectionTitle}>{title}</div>
      {children}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={S.row}>
      <span style={S.rowLabel}>{label}</span>
      <span style={mono ? S.rowValueMono : S.rowValue}>{value}</span>
    </div>
  );
}

function ToolRow({ tool }: { tool: AgentifiedTool }) {
  return (
    <div style={S.toolRow}>
      <div style={S.toolName}>{tool.name}</div>
      <div style={S.toolMeta}>
        score: {tool.score.toFixed(2)}
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function connectionLabel(status: ConnectionStatus): string {
  const map: Record<ConnectionStatus, string> = {
    idle: "Idle",
    connecting: "Connecting…",
    connected: "Connected",
    disconnected: "Disconnected",
    error: "Error",
  };
  return map[status];
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ── Styles ──────────────────────────────────────────────────────────────

const C = {
  bg: "#0c0c0e",
  surface: "#141418",
  border: "#1e1e24",
  text: "#c8c8d0",
  textDim: "#6b6b78",
  accent: "#58a6ff",
  agentified: "#d2a8ff",
  green: "#3fb950",
  yellow: "#d29922",
  red: "#f85149",
  bar: "#1c1c22",
  mono: "'SF Mono', 'Cascadia Code', 'Fira Code', Menlo, monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif",
};

function positionCss(pos: InspectorPosition): CSSProperties {
  const base: CSSProperties = { position: "fixed", zIndex: 99999 };
  switch (pos) {
    case "bottom-right": return { ...base, bottom: 16, right: 16 };
    case "bottom-left": return { ...base, bottom: 16, left: 16 };
    case "top-right": return { ...base, top: 16, right: 16 };
    case "top-left": return { ...base, top: 16, left: 16 };
  }
}

function toggleStyle(pos: InspectorPosition): CSSProperties {
  return {
    ...positionCss(pos),
    width: 36,
    height: 36,
    borderRadius: 8,
    border: `1px solid ${C.border}`,
    background: C.bg,
    color: C.agentified,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 18,
    padding: 0,
    boxShadow: "0 2px 12px rgba(0,0,0,0.5)",
  };
}

function panelStyle(pos: InspectorPosition): CSSProperties {
  return {
    ...positionCss(pos),
    width: 340,
    maxHeight: 480,
    borderRadius: 10,
    border: `1px solid ${C.border}`,
    background: C.bg,
    color: C.text,
    fontFamily: C.sans,
    fontSize: 12,
    lineHeight: "1.5",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    boxShadow: "0 4px 24px rgba(0,0,0,0.6)",
  };
}

function tabStyle(active: boolean): CSSProperties {
  return {
    background: "none",
    border: "none",
    borderBottom: active ? `2px solid ${C.accent}` : "2px solid transparent",
    color: active ? C.text : C.textDim,
    fontFamily: C.sans,
    fontSize: 11,
    fontWeight: active ? 600 : 400,
    padding: "6px 10px",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

function barFill(pct: number): CSSProperties {
  const color = pct > 90 ? C.red : pct > 70 ? C.yellow : C.accent;
  return {
    height: "100%",
    width: `${Math.min(pct, 100)}%`,
    background: color,
    borderRadius: 3,
    transition: "width 0.3s ease",
  };
}

function eventRowStyle(isAgentified: boolean): CSSProperties {
  return {
    display: "flex",
    gap: 8,
    padding: "3px 0",
    borderBottom: `1px solid ${C.border}`,
    ...(isAgentified ? { background: "rgba(210,168,255,0.04)" } : {}),
  };
}

const S = {
  toggleIcon: { lineHeight: 1 } as CSSProperties,

  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 12px",
    borderBottom: `1px solid ${C.border}`,
  } as CSSProperties,

  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  } as CSSProperties,

  headerDot: (status: ConnectionStatus): CSSProperties => ({
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: status === "connected" ? C.green
      : status === "connecting" ? C.yellow
      : status === "error" ? C.red
      : C.textDim,
    flexShrink: 0,
  }),

  headerTitle: {
    fontWeight: 700,
    fontSize: 12,
    letterSpacing: "0.02em",
  } as CSSProperties,

  closeBtn: {
    background: "none",
    border: "none",
    color: C.textDim,
    cursor: "pointer",
    fontSize: 13,
    padding: "2px 4px",
    lineHeight: 1,
  } as CSSProperties,

  tabs: {
    display: "flex",
    borderBottom: `1px solid ${C.border}`,
    padding: "0 4px",
  } as CSSProperties,

  body: {
    flex: 1,
    overflowY: "auto",
    padding: "8px 12px",
  } as CSSProperties,

  section: {
    marginBottom: 12,
  } as CSSProperties,

  sectionTitle: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: C.textDim,
    marginBottom: 6,
  } as CSSProperties,

  row: {
    display: "flex",
    justifyContent: "space-between",
    padding: "2px 0",
  } as CSSProperties,

  rowLabel: {
    color: C.textDim,
  } as CSSProperties,

  rowValue: {
    color: C.text,
    fontWeight: 500,
  } as CSSProperties,

  rowValueMono: {
    color: C.text,
    fontFamily: C.mono,
    fontSize: 11,
  } as CSSProperties,

  totalRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "4px 0 0",
    marginTop: 4,
    borderTop: `1px solid ${C.border}`,
    fontWeight: 600,
  } as CSSProperties,

  totalValue: {
    color: C.accent,
  } as CSSProperties,

  barOuter: {
    height: 6,
    background: C.bar,
    borderRadius: 3,
    overflow: "hidden",
  } as CSSProperties,

  barLabel: {
    textAlign: "right",
    fontSize: 10,
    color: C.textDim,
    marginTop: 2,
  } as CSSProperties,

  toolRow: {
    padding: "3px 0",
    borderBottom: `1px solid ${C.border}`,
  } as CSSProperties,

  toolName: {
    fontFamily: C.mono,
    fontSize: 11,
    color: C.text,
  } as CSSProperties,

  toolMeta: {
    fontSize: 10,
    color: C.textDim,
  } as CSSProperties,

  discoveryItem: {
    padding: "4px 0",
    borderBottom: `1px solid ${C.border}`,
  } as CSSProperties,

  discoveryQuery: {
    fontFamily: C.mono,
    fontSize: 11,
    color: C.agentified,
  } as CSSProperties,

  discoveryMeta: {
    fontSize: 10,
    color: C.textDim,
  } as CSSProperties,

  eventList: {
    overflowY: "auto",
    maxHeight: 340,
  } as CSSProperties,

  eventTime: {
    fontFamily: C.mono,
    fontSize: 10,
    color: C.textDim,
    flexShrink: 0,
  } as CSSProperties,

  eventType: (isAgentified: boolean): CSSProperties => ({
    fontFamily: C.mono,
    fontSize: 11,
    color: isAgentified ? C.agentified : C.text,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  }),

  emptyState: {
    textAlign: "center",
    color: C.textDim,
    padding: "24px 0",
    fontSize: 11,
  } as CSSProperties,
};
