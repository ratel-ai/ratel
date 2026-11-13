"use client";

import { cn } from "@ratel/design-system/cn";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type PopoverPosition, placePopover } from "@/lib/console/popover-position";
import { RANGE_PRESETS, type RangePreset } from "@/lib/synthesis/dashboard";

/**
 * The dashboard's time-range control: a preset selector ("Last 30 days", …) paired
 * with the resolved date span and a calendar popover for a custom start/end range.
 * Selection is driven entirely through the URL (`range`, `from`, `to`), matching
 * the `?project=` pattern, so the server component re-resolves and re-queries.
 */
export function DateRangeControl({
  preset,
  from,
  to,
  alignPicker = "start",
  unified = false,
  preserveLiveParams = false,
}: {
  preset: RangePreset | "custom";
  from: string;
  to: string;
  alignPicker?: "start" | "end";
  /**
   * Collapse the preset menu and the calendar into one trigger. Opt-in because
   * this control is also mounted on `/dashboard`, which keeps the split layout;
   * only the scoped surfaces pass it.
   */
  unified?: boolean;
  /** Preserve params written through native history after the last navigation. */
  preserveLiveParams?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const apply = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(
      preserveLiveParams ? window.location.search : params.toString(),
    );
    for (const [k, v] of Object.entries(updates)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  // One control, not two. A preset button beside a calendar button asked the
  // reader to work out which of the pair was in charge — and they disagreed on
  // sight, since the calendar always showed a concrete span even while a preset
  // was driving it. Custom range now lives inside the preset menu, and the
  // single trigger states the resolved span underneath whichever mode is active.
  const [pickerOpen, setPickerOpen] = useState(false);
  const activeLabel =
    preset === "custom"
      ? "Custom range"
      : (RANGE_PRESETS.find((p) => p.id === preset)?.label ?? "Last 30 days");

  return (
    <div className="relative flex flex-wrap items-center gap-3">
      <PresetSelector
        active={preset}
        label={activeLabel}
        detail={unified ? `${fmtShort(from)} – ${fmtShort(to)}` : undefined}
        onSelect={(id) => apply({ range: id, from: null, to: null })}
        onCustom={unified ? () => setPickerOpen(true) : undefined}
      />
      <DateRangePicker
        // Remount on a new resolved range so the draft seeds from fresh props.
        key={`${from}:${to}`}
        from={from}
        to={to}
        align={alignPicker}
        showTrigger={!unified}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onApply={(f, t) => apply({ range: "custom", from: f, to: t })}
      />
    </div>
  );
}

/* --------------------------------- presets -------------------------------- */

function PresetSelector({
  active,
  label,
  detail,
  onSelect,
  onCustom,
}: {
  active: RangePreset | "custom";
  label: string;
  detail?: string;
  onSelect: (id: RangePreset) => void;
  onCustom?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "flex items-center gap-2.5 rounded-lg border border-forest-300 bg-forest/40 px-3.5 py-2",
          "text-sm text-cream transition-colors hover:bg-forest/70",
        )}
      >
        <ClockIcon />
        <span className="flex min-w-0 flex-col items-start leading-tight">
          <span className="font-semibold">{label}</span>
          {detail && <span className="font-mono text-[10px] text-warm-muted">{detail}</span>}
        </span>
        <Chevron open={open} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 z-30 mt-2 w-52 overflow-hidden rounded-xl border border-forest-300 bg-base-deep/95 p-1.5 shadow-2xl backdrop-blur"
        >
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitemradio"
              aria-checked={p.id === active}
              onClick={() => {
                setOpen(false);
                onSelect(p.id);
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm",
                "transition-colors hover:bg-forest/60",
                p.id === active ? "text-cream" : "text-cream-dim",
              )}
            >
              <span
                className={cn(
                  "inline-block h-1.5 w-1.5 rounded-full",
                  p.id === active ? "bg-coral" : "bg-transparent",
                )}
                aria-hidden
              />
              {p.label}
            </button>
          ))}
          {onCustom && (
            <>
              <div className="my-1 h-px bg-forest-300/70" aria-hidden />
              <button
                type="button"
                role="menuitemradio"
                aria-checked={active === "custom"}
                onClick={() => {
                  setOpen(false);
                  onCustom();
                }}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm",
                  "transition-colors hover:bg-forest/60",
                  active === "custom" ? "text-cream" : "text-cream-dim",
                )}
              >
                <span
                  className={cn(
                    "inline-block h-1.5 w-1.5 rounded-full",
                    active === "custom" ? "bg-coral" : "bg-transparent",
                  )}
                  aria-hidden
                />
                Custom range…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------- date picker ------------------------------ */

function DateRangePicker({
  from,
  to,
  align,
  showTrigger,
  open,
  onOpenChange,
  onApply,
}: {
  from: string;
  to: string;
  align: "start" | "end";
  showTrigger: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (from: string, to: string) => void;
}) {
  const setOpen = onOpenChange;
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  useDismiss(open, () => setOpen(false), ref);
  usePopoverPosition(open, align, triggerRef, pickerRef, setPosition);

  // Draft selection, seeded from the resolved range (props are fixed per mount —
  // the parent remounts via `key` when the range changes).
  const [start, setStart] = useState(from);
  const [end, setEnd] = useState(to);
  const [view, setView] = useState(() => monthOf(to));

  const pickDay = (day: string) => {
    // First click (or restarting) sets the start; second click closes the range.
    if (!start || (start && end)) {
      setStart(day);
      setEnd("");
    } else if (day < start) {
      setEnd(start);
      setStart(day);
    } else {
      setEnd(day);
    }
  };

  const canApply = Boolean(start && end);
  const cells = monthCells(view.year, view.month);

  return (
    <div ref={ref}>
      {/* Unified mode has no trigger of its own — the single preset button
          opens this popover — so all that is left is a zero-size anchor for
          positioning. Legacy mode keeps the original standalone calendar
          button, and keeps it a real <button>: it is still the live
          /dashboard control, and a role="button" span would hand back native
          activation, focus and disabled behaviour for nothing. */}
      {showTrigger ? (
        <button
          ref={triggerRef as React.RefObject<HTMLButtonElement>}
          type="button"
          onClick={() => {
            if (!open) setView(monthOf(end || to));
            setOpen(!open);
          }}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={cn(
            "flex items-center gap-2.5 rounded-lg border border-forest-300 bg-forest/40 px-3.5 py-2",
            "text-sm text-cream transition-colors hover:bg-forest/70",
          )}
        >
          <CalendarIcon />
          <span className="font-semibold">
            {fmtShort(from)} – {fmtShort(to)}
          </span>
          <Chevron open={open} />
        </button>
      ) : (
        <span
          ref={triggerRef as React.RefObject<HTMLSpanElement>}
          aria-hidden
          className="block h-0 w-0"
        />
      )}

      {open && (
        <div
          ref={pickerRef}
          role="dialog"
          aria-label="Choose a custom date range"
          data-placement={position?.placement}
          style={
            position
              ? {
                  left: position.left,
                  top: position.top,
                  maxHeight: position.maxHeight,
                }
              : { visibility: "hidden" }
          }
          className={cn(
            "fixed z-30 w-80 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl border border-forest-300 bg-base-deep/95 p-4 shadow-2xl backdrop-blur",
          )}
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-cream">
              {monthTitle(view.year, view.month)}
            </span>
            <div className="flex items-center gap-1">
              <NavButton label="Previous month" onClick={() => setView((v) => stepMonth(v, -1))}>
                <path d="M7.5 3 4.5 6 7.5 9" />
              </NavButton>
              <NavButton label="Next month" onClick={() => setView((v) => stepMonth(v, 1))}>
                <path d="M4.5 3 7.5 6 4.5 9" />
              </NavButton>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-7 gap-y-1 text-center text-[11px] text-warm-muted">
            {WEEKDAYS.map((d, i) => (
              <span key={i} className="py-1">
                {d}
              </span>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-y-1 text-center text-sm">
            {cells.map((day) => {
              const inMonth = day.slice(0, 7) === isoMonth(view.year, view.month);
              const isStart = day === start;
              const isEnd = day === end;
              const endpoint = isStart || isEnd;
              const inRange = Boolean(start && end && day > start && day < end);
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => pickDay(day)}
                  className={cn(
                    "mx-auto flex h-9 w-9 items-center justify-center rounded-md transition-colors",
                    endpoint
                      ? "bg-coral font-semibold text-paper"
                      : inRange
                        ? "bg-coral/20 text-cream"
                        : "hover:bg-forest/60",
                    !endpoint && !inRange && (inMonth ? "text-cream-dim" : "text-warm-muted/50"),
                  )}
                >
                  {Number(day.slice(8, 10))}
                </button>
              );
            })}
          </div>

          <div className="mt-4 flex flex-col gap-3 border-t border-forest-300 pt-4">
            <Field label="Start" value={start ? fmtFull(start) : "—"} />
            <Field label="End" value={end ? fmtFull(end) : "—"} />
          </div>

          <button
            type="button"
            disabled={!canApply}
            onClick={() => {
              if (!canApply) return;
              setOpen(false);
              onApply(start, end);
            }}
            className={cn(
              "mt-4 flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors",
              canApply
                ? "bg-coral text-paper hover:bg-coral/90"
                : "cursor-not-allowed bg-forest/40 text-warm-muted",
            )}
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}

function usePopoverPosition(
  open: boolean,
  align: "start" | "end",
  triggerRef: RefObject<HTMLElement | null>,
  popoverRef: RefObject<HTMLElement | null>,
  setPosition: (position: PopoverPosition | null) => void,
) {
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    function update() {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) return;
      const anchor = trigger.getBoundingClientRect();
      const panel = popover.getBoundingClientRect();
      setPosition(
        placePopover({
          anchor,
          popover: panel,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          align,
        }),
      );
    }

    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [align, open, popoverRef, setPosition, triggerRef]);
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-warm-muted">{label}</div>
      <div className="mt-1 rounded-lg border border-forest-300 bg-forest/20 px-3 py-2 text-sm text-cream">
        {value}
      </div>
    </div>
  );
}

/* --------------------------------- helpers -------------------------------- */

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

function useDismiss(open: boolean, close: () => void, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close, ref]);
}

type MonthView = { year: number; month: number };

function monthOf(isoDay: string): MonthView {
  const d = new Date(`${isoDay}T00:00:00Z`);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

function stepMonth(v: MonthView, delta: number): MonthView {
  const d = new Date(Date.UTC(v.year, v.month + delta, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

function isoMonth(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** The 42 calendar cells (6 weeks, Sun-first) covering the given month. */
function monthCells(year: number, month: number): string[] {
  const first = new Date(Date.UTC(year, month, 1));
  const start = new Date(first);
  start.setUTCDate(1 - first.getUTCDay());
  const out: string[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function monthTitle(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function fmtShort(isoDay: string): string {
  return new Date(`${isoDay}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function fmtFull(isoDay: string): string {
  return new Date(`${isoDay}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/* ---------------------------------- icons --------------------------------- */

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      className={cn("text-warm-muted transition-transform", open && "rotate-180")}
      aria-hidden
    >
      <path
        d="M3 4.5 6 7.5 9 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      className="text-warm-muted"
      aria-hidden
    >
      <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M7 4.25V7l1.75 1.25"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      className="text-warm-muted"
      aria-hidden
    >
      <rect
        x="1.75"
        y="2.75"
        width="10.5"
        height="9.5"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M1.75 5.5h10.5M4.5 1.5v2M9.5 1.5v2"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

function NavButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md text-cream-dim transition-colors hover:bg-forest/60 hover:text-cream"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
        <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          {children}
        </g>
      </svg>
    </button>
  );
}
