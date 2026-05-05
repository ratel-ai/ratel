import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { CSSProperties } from "react";
import type {
  InspectorState,
  EventLogEntry,
  AgentifiedTool,
  ConnectionStatus,
  ToolCallDetail,
} from "@agentified/fe-client";
import { useAgentified } from "./hook.js";

// ── Types ──────────────────────────────────────────────────────────────

type Tab = "timeline" | "session" | "log";
type EventFilter = "all" | "agentified" | "tool_calls" | "messages";

export interface InspectorProps {
  defaultOpen?: boolean;
}

const TABS: { key: Tab; label: string }[] = [
  { key: "timeline", label: "Timeline" },
  { key: "session", label: "Session" },
  { key: "log", label: "Log" },
];

// ── Inspector ──────────────────────────────────────────────────────────

export function Inspector({ defaultOpen = false }: InspectorProps) {
  const { state } = useAgentified();
  const [open, setOpen] = useState(defaultOpen);
  const [activeTab, setActiveTab] = useState<Tab>("timeline");
  const [pos, setPos] = useState({ x: typeof window !== "undefined" ? window.innerWidth - 520 : 80, y: 80 });
  const [size, setSize] = useState({ w: 500, h: 500 });
  const [dragging, setDragging] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open && panelRef.current) {
      try { panelRef.current.showPopover(); } catch { /* popover not supported */ }
    }
  }, [open]);

  useEffect(() => {
    if (!open && triggerRef.current) {
      try { triggerRef.current.showPopover(); } catch { /* popover not supported */ }
    }
  }, [open]);

  const handleDragStart = useCallback((e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    const startX = e.clientX - pos.x;
    const startY = e.clientY - pos.y;
    const onMove = (ev: globalThis.PointerEvent) => {
      setPos({ x: ev.clientX - startX, y: ev.clientY - startY });
    };
    const onUp = () => {
      setDragging(false);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [pos.x, pos.y]);

  const handleResizeStart = useCallback((e: ReactPointerEvent) => {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = size.w;
    const startH = size.h;
    const onMove = (ev: globalThis.PointerEvent) => {
      setSize({
        w: Math.max(300, startW + ev.clientX - startX),
        h: Math.max(200, startH + ev.clientY - startY),
      });
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [size.w, size.h]);

  if (!open) {
    return (
      <button
        ref={triggerRef}
        // @ts-expect-error popover attribute not yet in React types
        popover="manual"
        data-testid="inspector-toggle"
        onClick={() => setOpen(true)}
        style={S.trigger}
        aria-label="Open Agentified Inspector"
      >
        <span style={S.triggerIcon}>◈</span>
      </button>
    );
  }

  const modalStyle: CSSProperties = {
    ...S.modal,
    left: pos.x,
    top: pos.y,
    width: size.w,
    height: size.h,
  };

  return (
    <div
      ref={panelRef}
      // @ts-expect-error popover attribute not yet in React types
      popover="manual"
      data-testid="inspector-panel"
      style={modalStyle}
    >
      <div
        style={{ ...S.header, cursor: dragging ? "grabbing" : "grab" }}
        onPointerDown={handleDragStart}
      >
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
        {activeTab === "timeline" && <TimelineTab state={state} />}
        {activeTab === "session" && <SessionTab state={state} />}
        {activeTab === "log" && <LogTab state={state} />}
      </div>

      <div
        data-testid="inspector-resize"
        style={S.resizeHandle}
        onPointerDown={handleResizeStart}
      />
    </div>
  );
}

// ── Tab: Timeline ─────────────────────────────────────────────────────

function TimelineTab({ state }: { state: InspectorState }) {
  const { connection, run, streaming, events, toolCalls, agentified, frontendTools = [], sharedContext } = state;

  return (
    <div>
      <Section title="Run">
        <div style={S.metricsRow}>
          <MetricPill label="Status" value={connectionLabel(connection)} />
          {run.runId && <MetricPill label="Run" value={run.runId} mono />}
          {run.durationMs != null && <MetricPill label="Duration" value={`${run.durationMs}ms`} />}
          {streaming.timeToFirstTokenMs != null && <MetricPill label="TTFT" value={`${streaming.timeToFirstTokenMs}ms`} />}
        </div>
      </Section>

      <Section title="Interaction Timeline">
        <TimelineList events={events} toolCalls={toolCalls} />
      </Section>

      {agentified.currentTools.length > 0 && (
        <Section title="Active Tools">
          <div style={S.toolTable}>
            {agentified.currentTools.map((tool, i) => (
              <ToolRow key={`${tool.name}-${i}`} tool={tool} />
            ))}
          </div>
        </Section>
      )}

      {frontendTools.length > 0 && (
        <Section title="Frontend Tools">
          <div style={S.frontendToolsList}>
            {frontendTools.map((name) => (
              <span key={name} style={S.frontendToolBadge}>
                <span style={S.frontendToolDot} />
                {name}
              </span>
            ))}
          </div>
        </Section>
      )}

      {sharedContext && (
        <Section title="Shared Context">
          <div style={S.sharedContext}>
            <Row label="Page" value={sharedContext.page} />
            {sharedContext.activeTab && <Row label="Tab" value={sharedContext.activeTab} />}
            {sharedContext.openModals.length > 0 && (
              <Row label="Open Modals" value={sharedContext.openModals.join(", ")} />
            )}
          </div>
        </Section>
      )}
    </div>
  );
}

function TimelineList({ events, toolCalls }: { events: EventLogEntry[]; toolCalls: ToolCallDetail[] }) {
  const listRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(events.length);

  useEffect(() => {
    if (events.length > prevLen.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    prevLen.current = events.length;
  }, [events.length]);

  if (events.length === 0) {
    return <div style={S.emptyState}>No events yet</div>;
  }

  const items = buildTimelineItems(events, toolCalls);

  return (
    <div ref={listRef} style={S.timelineList} data-testid="timeline-list">
      {items.map((item, i) => (
        <TimelineItem key={i} item={item} />
      ))}
    </div>
  );
}

interface TimelineItemData {
  type: "run_started" | "run_finished" | "agentified" | "tool_call" | "message" | "other";
  label: string;
  timestamp: number;
  detail?: string;
  expandable?: boolean;
  expanded?: Record<string, unknown>;
}

function buildTimelineItems(events: EventLogEntry[], toolCalls: ToolCallDetail[]): TimelineItemData[] {
  const items: TimelineItemData[] = [];
  const toolCallMap = new Map(toolCalls.map(tc => [tc.id, tc]));

  const seenToolCalls = new Set<string>();

  for (const entry of events) {
    const e = entry.event as Record<string, unknown>;
    const type = e.type as string;

    if (type === "RUN_STARTED") {
      items.push({ type: "run_started", label: `Run started${e.runId ? ` · ${e.runId}` : ""}`, timestamp: entry.timestamp });
    } else if (type === "RUN_FINISHED") {
      items.push({ type: "run_finished", label: "Run complete", timestamp: entry.timestamp });
    } else if (entry.isAgentified) {
      const name = (e as Record<string, unknown>).name as string;
      const value = (e as Record<string, unknown>).value as Record<string, unknown> | undefined;
      if (name === "agentified:prefetch:complete") {
        const tools = (value?.tools as unknown[]) ?? [];
        const dur = value?.durationMs ?? "?";
        items.push({ type: "agentified", label: `Prefetch · ${tools.length} tools · ${dur}ms`, timestamp: entry.timestamp, expandable: true, expanded: value });
      } else if (name === "agentified:discover:complete") {
        const query = (value?.query as string) ?? "";
        const tools = (value?.tools as unknown[]) ?? [];
        const dur = value?.durationMs ?? "?";
        items.push({ type: "agentified", label: `Discover "${query}" · ${tools.length} tools · ${dur}ms`, timestamp: entry.timestamp, expandable: true, expanded: value });
      } else {
        items.push({ type: "agentified", label: name, timestamp: entry.timestamp });
      }
    } else if (type === "TOOL_CALL_START") {
      const tcId = e.toolCallId as string;
      if (!seenToolCalls.has(tcId)) {
        seenToolCalls.add(tcId);
        const tc = toolCallMap.get(tcId);
        if (tc) {
          const dur = tc.durationMs != null ? ` · ${tc.durationMs}ms` : "";
          items.push({ type: "tool_call", label: `${tc.name}${dur}`, timestamp: entry.timestamp, expandable: true, expanded: { args: tc.args, result: tc.result } });
        }
      }
    } else if (type === "TEXT_MESSAGE_START") {
      const role = (e.role as string) ?? "assistant";
      items.push({ type: "message", label: `${role} message`, timestamp: entry.timestamp });
    } else if (type !== "TEXT_MESSAGE_CONTENT" && type !== "TEXT_MESSAGE_END" && type !== "TOOL_CALL_ARGS" && type !== "TOOL_CALL_END" && type !== "TOOL_CALL_RESULT") {
      items.push({ type: "other", label: type, timestamp: entry.timestamp });
    }
  }
  return items;
}

function TimelineItem({ item }: { item: TimelineItemData }) {
  const [expanded, setExpanded] = useState(false);
  const time = new Date(item.timestamp).toLocaleTimeString();
  const color = item.type === "agentified" ? C.agentified
    : item.type === "tool_call" ? C.accent
    : item.type === "run_started" || item.type === "run_finished" ? C.green
    : C.text;

  return (
    <div style={S.timelineItem} data-testid="timeline-item">
      <div
        style={{ ...S.timelineItemHeader, cursor: item.expandable ? "pointer" : "default" }}
        onClick={() => item.expandable && setExpanded(!expanded)}
      >
        <span style={S.timelineDot(color)} />
        <span style={S.timelineLabel(color)}>{item.label}</span>
        <span style={S.timelineTime}>{time}</span>
        {item.expandable && <span style={S.expandArrow}>{expanded ? "▾" : "▸"}</span>}
      </div>
      {expanded && item.expanded && (
        <pre style={S.timelineDetail} data-testid="timeline-detail">
          {JSON.stringify(item.expanded, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ── Tab: Session ──────────────────────────────────────────────────────

function SessionTab({ state }: { state: InspectorState }) {
  const { tokens, streaming, run, events, agentified } = state;
  const total = tokens.input + tokens.output + tokens.cached + tokens.reasoning;

  return (
    <div>
      <Section title="Metrics">
        <div style={S.metricsRow}>
          <MetricPill label="Messages" value={String(streaming.messageCount)} />
          <MetricPill label="Tool Calls" value={String(streaming.toolCallCount)} />
          {streaming.timeToFirstTokenMs != null && <MetricPill label="TTFT" value={`${streaming.timeToFirstTokenMs}ms`} />}
          {run.durationMs != null && <MetricPill label="Total" value={`${run.durationMs}ms`} />}
          {(tokens.input > 0 || tokens.output > 0) && (
            <MetricPill label="Tokens" value={formatNumber(total)} />
          )}
        </div>
      </Section>

      <Section title="Session Summary">
        <div style={S.statGrid}>
          <StatCell label="Events" value={String(events.length)} />
          <StatCell label="Messages" value={String(streaming.messageCount)} />
          <StatCell label="Tool Calls" value={String(streaming.toolCallCount)} />
          <StatCell label="Duration" value={run.durationMs != null ? `${run.durationMs}ms` : "—"} />
          <StatCell label="TTFT" value={streaming.timeToFirstTokenMs != null ? `${streaming.timeToFirstTokenMs}ms` : "—"} />
          <StatCell label="Tokens" value={total > 0 ? formatNumber(total) : "—"} />
        </div>
      </Section>

      {total > 0 && (
        <Section title="Token Breakdown">
          <div style={S.tokenBreakdown}>
            <Row label="Input" value={formatNumber(tokens.input)} />
            <Row label="Output" value={formatNumber(tokens.output)} />
            <Row label="Cached" value={formatNumber(tokens.cached)} />
            <Row label="Reasoning" value={formatNumber(tokens.reasoning)} />
          </div>
          {tokens.contextWindowPercent != null && (
            <div style={{ marginTop: 8 }}>
              <div style={S.barOuter}>
                <div data-testid="context-bar" style={barFill(tokens.contextWindowPercent)} />
              </div>
              <div style={S.barLabel}>Context: {tokens.contextWindowPercent.toFixed(1)}%</div>
            </div>
          )}
        </Section>
      )}

      {agentified.prefetchResults.length > 0 && (
        <Section title="Prefetch History">
          {agentified.prefetchResults.map((pr, i) => (
            <div key={i} style={S.historyItem}>
              <span style={S.historyLabel}>{pr.tools.length} tools</span>
              <span style={S.historyMeta}>{pr.durationMs}ms</span>
            </div>
          ))}
        </Section>
      )}

      {agentified.discoveries.length > 0 && (
        <Section title="Discovery History">
          {agentified.discoveries.map((d, i) => (
            <div key={i} style={S.historyItem}>
              <span style={S.discoveryQuery}>"{d.query}"</span>
              <span style={S.historyMeta}>{d.tools.length} tools · {d.durationMs}ms</span>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

function ToolRow({ tool }: { tool: AgentifiedTool }) {
  const pct = Math.round(tool.score * 100);
  return (
    <div style={S.toolRow} data-testid="tool-row">
      <div style={S.toolRowTop}>
        <span style={S.toolName}>{tool.name}</span>
        <span style={S.toolScore}>{tool.score.toFixed(2)}</span>
      </div>
      <div style={S.scoreBarOuter}>
        <div style={{ ...S.scoreBarFill, width: `${pct}%` }} />
      </div>
      {tool.description && <div style={S.toolDesc}>{tool.description.length > 60 ? tool.description.slice(0, 60) + "…" : tool.description}</div>}
    </div>
  );
}

// ── Tab: Log ──────────────────────────────────────────────────────────

function LogTab({ state }: { state: InspectorState }) {
  const [filter, setFilter] = useState<EventFilter>("all");
  const filteredEvents = filterEvents(state.events, filter);

  return (
    <div>
      <Section title="Event Log">
        <div style={S.filterRow}>
          {(["all", "agentified", "tool_calls", "messages"] as EventFilter[]).map(f => (
            <button
              key={f}
              data-testid={`filter-${f}`}
              onClick={() => setFilter(f)}
              style={filterBtnStyle(f === filter)}
            >
              {filterLabel(f)}
            </button>
          ))}
        </div>
        <EventLog events={filteredEvents} />
      </Section>
    </div>
  );
}

function filterEvents(events: EventLogEntry[], filter: EventFilter): EventLogEntry[] {
  if (filter === "all") return events;
  if (filter === "agentified") return events.filter(e => e.isAgentified);
  if (filter === "tool_calls") return events.filter(e => {
    const t = e.event.type as string;
    return t === "TOOL_CALL_START" || t === "TOOL_CALL_ARGS" || t === "TOOL_CALL_END" || t === "TOOL_CALL_RESULT";
  });
  if (filter === "messages") return events.filter(e => {
    const t = e.event.type as string;
    return t === "TEXT_MESSAGE_START" || t === "TEXT_MESSAGE_CONTENT" || t === "TEXT_MESSAGE_END";
  });
  return events;
}

function filterLabel(f: EventFilter): string {
  const map: Record<EventFilter, string> = { all: "All", agentified: "Agentified", tool_calls: "Tool Calls", messages: "Messages" };
  return map[f];
}

function EventLog({ events }: { events: EventLogEntry[] }) {
  const listRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(events.length);

  useEffect(() => {
    if (events.length > prevLen.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    prevLen.current = events.length;
  }, [events.length]);

  return (
    <div ref={listRef} style={S.eventList} data-testid="event-list">
      {events.length === 0 && <div style={S.emptyState}>No events</div>}
      {events.map((entry, i) => (
        <EventRow key={i} entry={entry} />
      ))}
    </div>
  );
}

function EventRow({ entry }: { entry: EventLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const time = new Date(entry.timestamp).toLocaleTimeString();
  const e = entry.event as Record<string, unknown>;
  const eventType = entry.isAgentified ? (e.name as string) : (e.type as string);

  return (
    <div style={eventRowStyle(entry.isAgentified)} data-testid="event-row">
      <div style={S.eventRowHeader} onClick={() => setExpanded(!expanded)}>
        <span style={S.eventTime}>{time}</span>
        <span style={S.eventType(entry.isAgentified)}>{eventType}</span>
        <span style={S.expandArrow}>{expanded ? "▾" : "▸"}</span>
      </div>
      {expanded && (
        <pre style={S.eventDetail} data-testid="event-detail">
          {JSON.stringify(entry.event, null, 2)}
        </pre>
      )}
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={S.row}>
      <span style={S.rowLabel}>{label}</span>
      <span style={S.rowValue}>{value}</span>
    </div>
  );
}

function MetricPill({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={S.metricPill}>
      <div style={S.metricPillLabel}>{label}</div>
      <div style={mono ? S.metricPillValueMono : S.metricPillValue}>{value}</div>
    </div>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={S.statCell} data-testid="stat-cell">
      <div style={S.statValue}>{value}</div>
      <div style={S.statLabel}>{label}</div>
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

function tabStyle(active: boolean): CSSProperties {
  return {
    background: "none",
    border: "none",
    borderBottom: active ? `2px solid ${C.accent}` : "2px solid transparent",
    color: active ? C.text : C.textDim,
    fontFamily: C.sans,
    fontSize: 11,
    fontWeight: active ? 600 : 400,
    padding: "6px 12px",
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
    padding: "2px 0",
    borderBottom: `1px solid ${C.border}`,
    ...(isAgentified ? { background: "rgba(210,168,255,0.04)" } : {}),
  };
}

function filterBtnStyle(active: boolean): CSSProperties {
  return {
    background: active ? "rgba(88,166,255,0.12)" : "none",
    border: `1px solid ${active ? C.accent : C.border}`,
    borderRadius: 4,
    color: active ? C.accent : C.textDim,
    fontSize: 10,
    padding: "2px 8px",
    cursor: "pointer",
    fontFamily: C.sans,
  };
}

const S = {
  trigger: {
    position: "fixed",
    bottom: 16,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 99999,
    width: 36,
    height: 36,
    borderRadius: "50%",
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
  } as CSSProperties,

  triggerIcon: { lineHeight: 1 } as CSSProperties,

  modal: {
    position: "fixed",
    zIndex: 99999,
    borderRadius: 12,
    border: `1px solid ${C.border}`,
    background: C.bg,
    color: C.text,
    fontFamily: C.sans,
    fontSize: 12,
    lineHeight: "1.5",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    boxShadow: "0 8px 48px rgba(0,0,0,0.7)",
  } as CSSProperties,

  resizeHandle: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: 12,
    height: 12,
    cursor: "nwse-resize",
    background: "linear-gradient(135deg, transparent 50%, rgba(200,200,208,0.3) 50%)",
    borderRadius: "0 0 12px 0",
  } as CSSProperties,

  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 16px",
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
    fontSize: 13,
    letterSpacing: "0.02em",
  } as CSSProperties,

  closeBtn: {
    background: "none",
    border: "none",
    color: C.textDim,
    cursor: "pointer",
    fontSize: 14,
    padding: "2px 4px",
    lineHeight: 1,
  } as CSSProperties,

  tabs: {
    display: "flex",
    borderBottom: `1px solid ${C.border}`,
    padding: "0 8px",
  } as CSSProperties,

  body: {
    flex: 1,
    overflowY: "auto",
    padding: "10px 16px",
  } as CSSProperties,

  section: {
    marginBottom: 14,
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

  // Timeline
  metricsRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
  } as CSSProperties,

  metricPill: {
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: "4px 8px",
    minWidth: 60,
  } as CSSProperties,

  metricPillLabel: {
    fontSize: 9,
    color: C.textDim,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  } as CSSProperties,

  metricPillValue: {
    fontSize: 12,
    fontWeight: 600,
    color: C.text,
  } as CSSProperties,

  metricPillValueMono: {
    fontSize: 11,
    fontWeight: 600,
    color: C.text,
    fontFamily: C.mono,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: 120,
  } as CSSProperties,

  timelineList: {
    overflowY: "auto",
    maxHeight: 300,
  } as CSSProperties,

  timelineItem: {
    borderBottom: `1px solid ${C.border}`,
    padding: "4px 0",
  } as CSSProperties,

  timelineItemHeader: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  } as CSSProperties,

  timelineDot: (color: string): CSSProperties => ({
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: color,
    flexShrink: 0,
  }),

  timelineLabel: (color: string): CSSProperties => ({
    fontFamily: C.mono,
    fontSize: 11,
    color,
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  }),

  timelineTime: {
    fontFamily: C.mono,
    fontSize: 10,
    color: C.textDim,
    flexShrink: 0,
  } as CSSProperties,

  timelineDetail: {
    fontFamily: C.mono,
    fontSize: 10,
    color: C.textDim,
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 4,
    padding: 8,
    margin: "4px 0 0 12px",
    overflow: "auto",
    maxHeight: 150,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  } as CSSProperties,

  expandArrow: {
    fontSize: 10,
    color: C.textDim,
    flexShrink: 0,
    width: 12,
    textAlign: "center",
  } as CSSProperties,

  // Learning
  toolTable: {} as CSSProperties,

  toolRow: {
    padding: "4px 0",
    borderBottom: `1px solid ${C.border}`,
  } as CSSProperties,

  toolRowTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  } as CSSProperties,

  toolName: {
    fontFamily: C.mono,
    fontSize: 11,
    color: C.text,
  } as CSSProperties,

  toolScore: {
    fontFamily: C.mono,
    fontSize: 11,
    color: C.accent,
  } as CSSProperties,

  scoreBarOuter: {
    height: 3,
    background: C.bar,
    borderRadius: 2,
    overflow: "hidden",
    marginTop: 2,
  } as CSSProperties,

  scoreBarFill: {
    height: "100%",
    background: C.accent,
    borderRadius: 2,
    transition: "width 0.3s ease",
  } as CSSProperties,

  toolDesc: {
    fontSize: 10,
    color: C.textDim,
    marginTop: 2,
  } as CSSProperties,

  historyItem: {
    display: "flex",
    justifyContent: "space-between",
    padding: "3px 0",
    borderBottom: `1px solid ${C.border}`,
  } as CSSProperties,

  historyLabel: {
    fontSize: 11,
    color: C.text,
  } as CSSProperties,

  historyMeta: {
    fontSize: 10,
    color: C.textDim,
  } as CSSProperties,

  discoveryQuery: {
    fontFamily: C.mono,
    fontSize: 11,
    color: C.agentified,
  } as CSSProperties,

  // Data
  statGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 6,
  } as CSSProperties,

  statCell: {
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: "6px 8px",
    textAlign: "center",
  } as CSSProperties,

  statValue: {
    fontSize: 14,
    fontWeight: 700,
    color: C.text,
  } as CSSProperties,

  statLabel: {
    fontSize: 9,
    color: C.textDim,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  } as CSSProperties,

  tokenBreakdown: {
    marginTop: 8,
    padding: "6px 8px",
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
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

  filterRow: {
    display: "flex",
    gap: 4,
    marginBottom: 8,
  } as CSSProperties,

  eventList: {
    overflowY: "auto",
    maxHeight: 250,
  } as CSSProperties,

  eventRowHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    cursor: "pointer",
    padding: "2px 0",
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
    flex: 1,
  }),

  eventDetail: {
    fontFamily: C.mono,
    fontSize: 10,
    color: C.textDim,
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 4,
    padding: 6,
    margin: "4px 0 0",
    overflow: "auto",
    maxHeight: 120,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  } as CSSProperties,

  emptyState: {
    textAlign: "center",
    color: C.textDim,
    padding: "24px 0",
    fontSize: 11,
  } as CSSProperties,

  frontendToolsList: {
    display: "flex",
    flexWrap: "wrap",
    gap: 4,
  } as CSSProperties,

  frontendToolBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    background: "rgba(63,185,80,0.1)",
    border: `1px solid rgba(63,185,80,0.3)`,
    borderRadius: 4,
    padding: "2px 8px",
    fontFamily: C.mono,
    fontSize: 10,
    color: C.green,
  } as CSSProperties,

  frontendToolDot: {
    width: 5,
    height: 5,
    borderRadius: "50%",
    background: C.green,
    flexShrink: 0,
  } as CSSProperties,

  sharedContext: {
    padding: "4px 8px",
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
  } as CSSProperties,
};
