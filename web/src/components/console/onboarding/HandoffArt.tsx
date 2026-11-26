// biome-ignore-all lint/suspicious/noArrayIndexKey: fixed grids of dots, keyed by position, never reordered.
import { BadgerMark } from "@ratel/design-system/badger-mark";
import { cn } from "@ratel/design-system/cn";
import type { ReactNode } from "react";

/**
 * The key reveal's illustration: the customer's agent on the left, Ratel on the right, and a
 * run of dots between them where a coral pulse travels toward Ratel: the first trace on its way.
 * Drawn in the brand's dot-matrix (DESIGN.md, Brand) instead of a mascot, and it says what the
 * page is for. The pulse is the design system's loader dot, so reduced motion gets it still.
 */

/** A prompt glyph, `>_`, on a 7×5 grid: 1 lit, 0 at rest. */
const PROMPT_GLYPH = ["1000000", "0100000", "0010000", "0100000", "1000111"];

/** Lit dots that blink, as a cursor does: the `_`. */
const CURSOR = new Set(["4:4", "4:5", "4:6"]);

const PATH_DOTS = 9;

export function HandoffArt({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("flex items-center gap-2.5", className)}>
      <Tile label="Your agent">
        <span className="inline-grid grid-cols-7 gap-[3px]">
          {PROMPT_GLYPH.flatMap((row, r) =>
            [...row].map((cell, c) => {
              const lit = cell === "1";
              const cursor = CURSOR.has(`${r}:${c}`);
              return (
                <span
                  key={`${r}:${c}`}
                  className={cn(
                    "size-1 rounded-full",
                    lit ? "bg-cream" : "bg-forest-300",
                    cursor && "dot-loader-dot",
                  )}
                />
              );
            }),
          )}
        </span>
      </Tile>

      <span className="flex items-center gap-[5px] pb-5 text-coral">
        {Array.from({ length: PATH_DOTS }, (_, index) => (
          <span
            key={index}
            className="dot-loader-dot size-1 rounded-full bg-current"
            style={{ animationDelay: `${index * 110}ms` }}
          />
        ))}
      </span>

      <Tile label="Ratel" tone="ready">
        <BadgerMark className="h-7 w-auto" />
      </Tile>
    </div>
  );
}

function Tile({
  label,
  tone = "rest",
  children,
}: {
  label: string;
  tone?: "rest" | "ready";
  children: ReactNode;
}) {
  return (
    <span className="flex flex-col items-center gap-1.5">
      <span
        className={cn(
          "flex size-16 items-center justify-center rounded-xl border bg-base-deep/70",
          tone === "ready" ? "border-green/50 text-green" : "border-forest-300/80 text-cream",
        )}
      >
        {children}
      </span>
      <span className="font-mono text-[10px] text-warm-muted">{label}</span>
    </span>
  );
}
