import type { LayoutSnapshot } from "@/lib/views/overview-layout/actions";
import { isEarlier } from "@/lib/views/overview-layout/domain/history";
import { type OverviewLayout, sameLayout } from "@/lib/views/overview-layout/domain/layout";

/** `current`: the layout changed in another place, and this is it. */
export type Refused = { ok: false; message: string; current?: LayoutSnapshot };
export type Saved = ({ ok: true; changed: string | null } & LayoutSnapshot) | Refused;

export const FAILED: Refused = { ok: false, message: "The server did not answer." };
/** It waited behind a write that was refused, which is what the person reads. */
export const DROPPED: Refused = { ok: false, message: "" };

/** What the page does when the queue says so. */
export interface LayoutScreen {
  show: (layout: OverviewLayout) => void;
  undoable: (undo: string | null) => void;
  pending: (count: number) => void;
  /** Nothing was saved, and the last saved layout shows. */
  refused: () => void;
  /** A widget that came back in another place has no body on this page yet. */
  changedElsewhere: () => void;
}

type Write = (base: string) => Promise<Saved>;

export type LayoutQueue = ReturnType<typeof createLayoutQueue>;

/** The layout's writes of one page, and the last saved layout. No React. */
export function createLayoutQueue(initial: LayoutSnapshot, screen: LayoutScreen) {
  let saved = initial;
  let tail: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  /** Counts what the page did or saw, to name the latest change. */
  let changes = 0;
  /** Goes up when the changes that wait are dropped. */
  let line = 0;
  let refusals = 0;

  const take = ({ layout, revision, undo }: LayoutSnapshot) => {
    saved = { layout, revision, undo };
    screen.undoable(undo);
  };

  const settle = (result: Saved) => {
    if (result.ok) {
      take(result);
      // Nothing else is drawn on top of it.
      if (waiting === 1) screen.show(result.layout);
      return;
    }
    if (result.current) {
      take(result.current);
      line += 1;
      screen.changedElsewhere();
    }
    refusals += 1;
    // Nothing was saved, so there is no change of this page's to take back.
    changes += 1;
    screen.show(saved.layout);
    screen.refused();
  };

  const add = (write: Write, dropped: () => boolean): Promise<Saved> => {
    changes += 1;
    waiting += 1;
    screen.pending(waiting);
    const mine = line;
    const done = tail
      .then(async () => {
        if (mine !== line || dropped()) {
          if (waiting === 1) screen.show(saved.layout);
          return DROPPED;
        }
        const result = await write(saved.revision).catch(() => FAILED);
        settle(result);
        return result;
      })
      .finally(() => {
        waiting -= 1;
        screen.pending(waiting);
      });
    tail = done;
    return done;
  };

  const elsewhere = (at: LayoutSnapshot) => {
    // A toast's Undo is not for somebody else's change.
    changes += 1;
    take(at);
    screen.show(at.layout);
  };

  return {
    /** Runs a write after the ones before it, on the revision they left. */
    enqueue: (write: Write) => add(write, () => false),
    /** An undo is for what the person saw: when a write before it is refused, it would take back an older change. */
    enqueueUndo(write: Write) {
      const seen = refusals;
      return add(write, () => seen !== refusals);
    },
    /** A fresh render of the server's. The one of an earlier save can come late. */
    served(at: LayoutSnapshot) {
      if (waiting > 0 || isEarlier(at.revision, saved.revision)) return;
      if (at.revision === saved.revision && sameLayout(at.layout, saved.layout)) return;
      elsewhere(at);
    },
    /** A history that was read: what it lists is what the page shows, so Restore is on the list that was read. */
    read(at: LayoutSnapshot) {
      if (waiting > 0 || at.revision === saved.revision) return;
      elsewhere(at);
      screen.changedElsewhere();
    },
    latest: () => changes,
    current: () => saved,
    /** After the writes that wait. */
    idle: () => tail,
  };
}
