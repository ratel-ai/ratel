"use client";

import { Button, IconButton } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Section } from "@ratel/design-system/section";
import { ChartColumn, Table2 } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { formatDayRange, formatInteger } from "@/lib/synthesis/traces/v2/format";
import {
  axisLabels,
  BAR_RADIUS,
  barLayout,
  bucketLabel,
  canSelectDays,
  selectionDays,
  selectionTotals,
  selectionWindow,
  stackHeights,
  type VolumeBucket,
  type VolumeModel,
} from "@/lib/synthesis/traces/v2/volume";

/** Room above the top gridline for its label. */
const PLOT_TOP = 18;
const PLOT_HEIGHT = 104;
const BASELINE = PLOT_TOP + PLOT_HEIGHT;
/** Width drawn before the browser measures; the viewBox makes it fit until then. */
const NOMINAL_WIDTH = 1100;

type Range = readonly [number, number];
/** A selection in progress, and what drives it: the hint says "Release" to a pointer and "Press Enter" to keys. */
type Drag = { anchor: number; focus: number; by: "pointer" | "keys" };

/**
 * Runs per time bucket (DESIGN.md, Data visualization). Thin bars with a 2 px
 * gap and 4 px rounded tops; failed runs in danger on the shared baseline so
 * they compare across bars, completed runs in a quiet gray above them; a
 * recessive axis. Hover or arrow keys read a bar; dragging across bars (or
 * Shift with the arrows, then Enter) narrows the time window to their days,
 * when the window has more than one day to narrow to. Times are UTC, like
 * the window's days.
 */
export function VolumeChart({
  model,
  zoomed,
  pending,
  onSelectDays,
  onReset,
}: {
  model: VolumeModel;
  /** The window is a custom range (a zoom): offer the way back. */
  zoomed: boolean;
  pending: boolean;
  onSelectDays: (days: { from: string; to: string }) => void;
  onReset: () => void;
}) {
  const [showTable, setShowTable] = useState(false);
  const { buckets, totals } = model;
  const completed = totals.count - totals.errorCount;

  return (
    <Section
      title="Runs over time"
      actions={
        <>
          {zoomed ? (
            <Button variant="ghost" size="sm" onClick={onReset}>
              Reset range
            </Button>
          ) : null}
          <IconButton
            label={showTable ? "Show as chart" : "Show as table"}
            size="icon-sm"
            icon={showTable ? <ChartColumn /> : <Table2 />}
            onClick={() => setShowTable((current) => !current)}
          />
        </>
      }
    >
      <div className="-mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
        <ul
          aria-label="Legend"
          className="flex flex-wrap items-center gap-x-4 gap-y-1 text-fg-muted"
        >
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-2 rounded-[2px] bg-fg-faint" />
            Completed
            <span className="text-fg tabular-nums">{formatInteger(completed)}</span>
          </li>
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-2 rounded-[2px] bg-danger" />
            Failed
            <span className="text-fg tabular-nums">{formatInteger(totals.errorCount)}</span>
          </li>
        </ul>
        {model.stepHours < 24 ? <p className="text-fg-subtle">Times in UTC</p> : null}
      </div>
      <div
        className={cn("transition-opacity duration-160", pending && "opacity-60")}
        aria-busy={pending || undefined}
      >
        {showTable ? (
          <VolumeTable buckets={buckets} stepHours={model.stepHours} />
        ) : (
          <VolumePlot model={model} onSelectDays={onSelectDays} />
        )}
      </div>
    </Section>
  );
}

function VolumePlot({
  model,
  onSelectDays,
}: {
  model: VolumeModel;
  onSelectDays: (days: { from: string; to: string }) => void;
}) {
  const { buckets, stepHours, scaleMax, totals } = model;
  const hostRef = useRef<HTMLDivElement>(null);
  // Mirrors the drag so pointerup reads the live gesture, not the last render.
  const dragRef = useRef<Drag | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const baseId = useId();
  const descriptionId = `${baseId}-description`;
  const optionId = (index: number) => `${baseId}-bar-${index}`;
  // The URL keeps whole UTC days: a one-day window has nothing narrower to select.
  const selectable = canSelectDays(buckets);

  const plotWidth = width || NOMINAL_WIDTH;
  const layout = useMemo(() => barLayout(plotWidth, buckets.length), [plotWidth, buckets.length]);
  // About one label per 160 px, so a phone-width axis never crowds.
  const labels = useMemo(
    () => axisLabels(model, Math.max(2, Math.min(6, Math.floor(plotWidth / 160)))),
    [model, plotWidth],
  );
  const selection: Range | null = drag ? ordered(drag) : null;
  const active = selection ? selection[1] : (hover ?? cursor);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => setWidth(host.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const setDragState = useCallback((next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  // A drag can end anywhere on the page; Escape must reach it either way.
  useEffect(() => {
    if (!drag) return;
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setDragState(null);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [drag, setDragState]);

  function indexAt(clientX: number): number | null {
    const host = hostRef.current;
    if (!host || buckets.length === 0) return null;
    const rect = host.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const ratio = Math.min(0.999999, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.floor(ratio * buckets.length);
  }

  function commit(range: Range) {
    const days = selectionWindow(buckets, range);
    if (days) onSelectDays(days);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const index = indexAt(event.clientX);
    if (index === null) return;
    // A tap reads the bar: touch screens have no hover.
    setHover(index);
    if (!selectable) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragState({ anchor: index, focus: index, by: "pointer" });
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const index = indexAt(event.clientX);
    if (index === null) return;
    setHover(index);
    const current = dragRef.current;
    if (current && current.focus !== index) setDragState({ ...current, focus: index });
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const current = dragRef.current;
    setDragState(null);
    // A click reads the bar; only a drag across bars changes the window.
    if (current && current.anchor !== current.focus) commit(ordered(current));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (buckets.length === 0) return;
    const at = cursor ?? lastBusy(buckets);
    const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (step !== 0) {
      event.preventDefault();
      const next = Math.min(buckets.length - 1, Math.max(0, at + step));
      setCursor(next);
      setDragState(
        event.shiftKey && selectable
          ? { anchor: dragRef.current?.anchor ?? at, focus: next, by: "keys" }
          : null,
      );
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setCursor(event.key === "Home" ? 0 : buckets.length - 1);
      setDragState(null);
      return;
    }
    if (event.key === "Enter" && dragRef.current) {
      event.preventDefault();
      commit(ordered(dragRef.current));
      setDragState(null);
    }
  }

  const readout = active === null ? null : buckets[active];
  const readoutTotals = selection ? selectionTotals(buckets, selection) : readout;
  const readoutTitle = selection
    ? formatDayRange(...dayPair(selectionDays(buckets, selection)))
    : readout
      ? bucketLabel(readout, stepHours)
      : "";
  // Say what letting go does, and only when it does something.
  const target = selection ? selectionWindow(buckets, selection) : null;
  const targetLabel = target ? formatDayRange(target.from, target.to) : null;
  const anchorX = active === null ? 0 : layout.x(active) + layout.barWidth / 2;
  const inSelection = (index: number) =>
    selection !== null && index >= selection[0] && index <= selection[1];

  return (
    <figure className="m-0">
      {/* A listbox of time buckets: the arrows read them and, where the window
          has days to narrow to, Shift with the arrows selects a range. The
          bars are drawn; the options say them for assistive tech. */}
      <div
        ref={hostRef}
        role="listbox"
        tabIndex={0}
        aria-label={`Runs over time: ${formatInteger(totals.count)} runs, ${formatInteger(totals.errorCount)} failed.`}
        aria-describedby={descriptionId}
        aria-multiselectable={selectable || undefined}
        aria-readonly={selectable ? undefined : true}
        aria-activedescendant={cursor !== null ? optionId(cursor) : undefined}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setCursor(null);
          setDragState(null);
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDragState(null)}
        onPointerLeave={() => {
          if (!dragRef.current) setHover(null);
        }}
        className={cn(
          // Vertical swipes still scroll the page on phones; sideways drags select.
          "relative touch-pan-y rounded-md outline-none select-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app",
          selectable ? "cursor-crosshair" : "cursor-default",
        )}
        style={{ height: BASELINE + 24 }}
      >
        <svg
          viewBox={`0 0 ${plotWidth} ${BASELINE}`}
          width="100%"
          height={BASELINE}
          preserveAspectRatio="none"
          aria-hidden
          className="block overflow-visible"
        >
          {[PLOT_TOP, PLOT_TOP + PLOT_HEIGHT / 2].map((y) => (
            <line
              key={y}
              x1={0}
              x2={plotWidth}
              y1={y + 0.5}
              y2={y + 0.5}
              stroke="var(--ds-line)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {selection ? (
            <rect
              x={selection[0] * layout.slot}
              width={(selection[1] - selection[0] + 1) * layout.slot}
              y={0}
              height={BASELINE}
              fill="var(--ds-selected)"
            />
          ) : null}
          {buckets.map((bucket, index) => (
            <Bar
              key={bucket.startMs}
              bucket={bucket}
              x={layout.x(index)}
              width={layout.barWidth}
              scaleMax={scaleMax}
              lifted={selection ? inSelection(index) : active === index}
              dimmed={selection !== null && !inSelection(index)}
            />
          ))}
          <line
            x1={0}
            x2={plotWidth}
            y1={BASELINE - 0.5}
            y2={BASELINE - 0.5}
            stroke="var(--ds-line-strong)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {buckets.map((bucket, index) => (
          <div
            key={bucket.startMs}
            id={optionId(index)}
            role="option"
            aria-selected={inSelection(index)}
            className="sr-only"
          >
            {`${bucketLabel(bucket, stepHours)}: ${formatInteger(bucket.count)} runs, ${formatInteger(bucket.errorCount)} failed`}
          </div>
        ))}

        {/* The scale is stated, not implied: the top gridline's value. */}
        <span
          aria-hidden
          className="pointer-events-none absolute top-0 left-0 text-xs leading-4 text-fg-subtle tabular-nums"
        >
          {formatInteger(scaleMax)}
        </span>

        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 h-6"
          style={{ top: BASELINE }}
        >
          {labels.map(({ index, label }) => {
            const center = layout.x(index) + layout.barWidth / 2;
            const ratio = center / plotWidth;
            return (
              <span
                key={index}
                className={cn(
                  "absolute top-1.5 text-xs leading-4 whitespace-nowrap text-fg-subtle tabular-nums",
                  ratio < 0.03
                    ? "translate-x-0"
                    : ratio > 0.97
                      ? "-translate-x-full"
                      : "-translate-x-1/2",
                )}
                style={{ left: `${ratio * 100}%` }}
              >
                {label}
              </span>
            );
          })}
        </div>

        {readout && readoutTotals ? (
          <div
            aria-hidden
            className="pointer-events-none absolute z-sticky rounded-lg border border-line bg-overlay px-2.5 py-2 text-xs whitespace-nowrap shadow-overlay"
            // Beside the bar it reads, never over it: right of it on the left
            // side of the plot, left of it on the right side.
            style={
              anchorX < plotWidth * 0.6
                ? {
                    top: PLOT_TOP,
                    left: `${((anchorX + layout.barWidth / 2 + 8) / plotWidth) * 100}%`,
                  }
                : {
                    top: PLOT_TOP,
                    right: `${(1 - (anchorX - layout.barWidth / 2 - 8) / plotWidth) * 100}%`,
                  }
            }
          >
            <p className="text-fg-subtle">{readoutTitle}</p>
            <p className="mt-1 flex items-center gap-2">
              <span aria-hidden className="h-0.5 w-3 rounded-full bg-fg-faint" />
              <span className="font-semibold text-fg tabular-nums">
                {formatInteger(readoutTotals.count - readoutTotals.errorCount)}
              </span>
              <span className="text-fg-muted">Completed</span>
            </p>
            <p className="mt-0.5 flex items-center gap-2">
              <span aria-hidden className="h-0.5 w-3 rounded-full bg-danger" />
              <span className="font-semibold text-fg tabular-nums">
                {formatInteger(readoutTotals.errorCount)}
              </span>
              <span className="text-fg-muted">Failed</span>
            </p>
            {targetLabel ? (
              <p className="mt-1.5 text-fg-subtle">
                {drag?.by === "keys" ? "Press Enter" : "Release"} to show {targetLabel}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <figcaption id={descriptionId} className="sr-only">
        {selectable
          ? "Use the left and right arrow keys to read each bar. Hold Shift with the arrows to select bars, then press Enter to show those days."
          : "Use the left and right arrow keys to read each bar."}
      </figcaption>
      <p role="status" className="sr-only">
        {selection && readoutTotals && targetLabel
          ? `${readoutTitle} selected: ${formatInteger(readoutTotals.count)} runs, ${formatInteger(readoutTotals.errorCount)} failed. Press Enter to show ${targetLabel}.`
          : ""}
      </p>
    </figure>
  );
}

function Bar({
  bucket,
  x,
  width,
  scaleMax,
  lifted,
  dimmed,
}: {
  bucket: VolumeBucket;
  x: number;
  width: number;
  scaleMax: number;
  lifted: boolean;
  dimmed: boolean;
}) {
  if (bucket.count <= 0 || width <= 0) return null;
  const { error, ok, gap } = stackHeights(bucket, scaleMax, PLOT_HEIGHT);
  const opacity = dimmed ? 0.35 : 1;
  const errorTop = BASELINE - error;
  const okTop = errorTop - gap - ok;
  return (
    <g opacity={opacity}>
      {error > 0 ? (
        <path
          d={ok > 0 ? squareRect(x, errorTop, width, error) : roundedTop(x, errorTop, width, error)}
          fill="var(--ds-danger)"
        />
      ) : null}
      {ok > 0 ? (
        <path
          d={roundedTop(x, okTop, width, ok)}
          fill={lifted ? "var(--ds-fg-muted)" : "var(--ds-fg-faint)"}
        />
      ) : null}
    </g>
  );
}

/** A bar segment with 4 px rounded top corners and a square base. */
function roundedTop(x: number, y: number, width: number, height: number): string {
  const r = Math.min(BAR_RADIUS, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

function squareRect(x: number, y: number, width: number, height: number): string {
  return `M${x},${y + height}V${y}H${x + width}V${y + height}Z`;
}

function ordered({ anchor, focus }: Pick<Drag, "anchor" | "focus">): Range {
  return anchor <= focus ? [anchor, focus] : [focus, anchor];
}

function dayPair(days: { from: string; to: string } | null): [string, string] {
  return days ? [days.from, days.to] : ["", ""];
}

/** Arrow keys start from the latest bucket that saw runs: what happened most recently. */
function lastBusy(buckets: readonly VolumeBucket[]): number {
  for (let index = buckets.length - 1; index >= 0; index -= 1) {
    if (buckets[index].count > 0) return index;
  }
  return buckets.length - 1;
}

/** The numbers behind the chart, one click away (DESIGN.md, Data visualization). */
function VolumeTable({
  buckets,
  stepHours,
}: {
  buckets: readonly VolumeBucket[];
  stepHours: number;
}) {
  const busy = buckets.filter((bucket) => bucket.count > 0);
  return (
    <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
      <table className="w-full border-separate border-spacing-0 text-ui">
        <caption className="sr-only">Runs per time bucket</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky top-0 h-8 border-b border-line bg-app px-3 text-left text-xs font-medium text-fg-subtle"
            >
              Time (UTC)
            </th>
            <th
              scope="col"
              className="sticky top-0 h-8 border-b border-line bg-app px-3 text-right text-xs font-medium text-fg-subtle"
            >
              Runs
            </th>
            <th
              scope="col"
              className="sticky top-0 h-8 border-b border-line bg-app px-3 text-right text-xs font-medium text-fg-subtle"
            >
              Failed
            </th>
          </tr>
        </thead>
        <tbody>
          {busy.map((bucket) => (
            <tr key={bucket.startMs}>
              {/* The header says UTC once; the cells need not repeat it. */}
              <td className="h-8 border-b border-line px-3 text-fg-muted tabular-nums">
                {bucketLabel(bucket, stepHours, { zone: false })}
              </td>
              <td className="h-8 border-b border-line px-3 text-right text-fg tabular-nums">
                {formatInteger(bucket.count)}
              </td>
              <td className="h-8 border-b border-line px-3 text-right text-fg tabular-nums">
                {formatInteger(bucket.errorCount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
