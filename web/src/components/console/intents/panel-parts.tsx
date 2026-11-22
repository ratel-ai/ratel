"use client";

import { DotMeter } from "@ratel/design-system/dot-matrix";
import { IntentPin, type Noun, NounIcon, ToolPin } from "@ratel/design-system/entity";
import type { ReactNode } from "react";

export const pct = (value: number) => `${Math.round(value * 100)}%`;
export const n = (value: number) => value.toLocaleString("en-US");
const SKILL = "skill:";

/**
 * The parts an intent's panel is built from: a titled block headed by its
 * noun's mark (or its own), a share as a meter and a percent, an intent that
 * opens its own panel, and a tool or skill by its stored id. Names and asks
 * are text only, never an attribute.
 */
export function Block({
  noun,
  mark,
  title,
  count,
  action,
  children,
}: {
  noun?: Noun;
  /** In place of the noun's mark, for a part the nouns have no icon for. */
  mark?: ReactNode;
  title: string;
  /** How many rows the block holds, listed or not. */
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-7 items-center gap-2">
        <h3 className="flex flex-1 items-center gap-1.5 text-sm font-semibold text-fg">
          {mark ?? (noun ? <NounIcon noun={noun} /> : null)}
          {title}
          {count !== undefined ? (
            <span className="text-xs font-normal text-fg-subtle tabular-nums">{n(count)}</span>
          ) : null}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A share as ten cells and its percent: the last two cells of a panel row. */
export function Share({ share, label }: { share: number; label: string }) {
  return (
    <>
      <DotMeter value={share} cells={10} tone="neutral" label={`${pct(share)} ${label}`} />
      <span className="text-right text-xs text-fg-muted tabular-nums">{pct(share)}</span>
    </>
  );
}

/** An intent as its pin, opening its own panel in place. */
export function IntentButton({ name, onOpen }: { name: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group min-w-0 max-w-full justify-self-start rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <IntentPin
        name={name}
        className="transition-colors duration-120 group-hover:border-line-strong group-hover:text-fg"
      />
    </button>
  );
}

/** A stored tool id as its pin: `skill:<id>` is a skill by its id, anything else a catalog tool. */
export function StoredToolPin({
  id,
  href,
  className,
}: {
  id: string;
  href?: string;
  className?: string;
}) {
  const skill = id.startsWith(SKILL);
  return (
    <ToolPin
      name={skill ? id.slice(SKILL.length) : id}
      kind={skill ? "skill" : "tool"}
      href={href}
      className={className}
    />
  );
}
