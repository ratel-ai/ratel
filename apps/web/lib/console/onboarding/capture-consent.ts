/**
 * What the key reveal tells a new customer Ratel will read, in one place.
 *
 * Kept out of the component for the same reason as the tour copy: this is a
 * promise about someone's data, so it should be readable and reviewable without
 * a DOM, and a test should notice when it changes. Plain language on purpose:
 * the reader is a founder with an agent, not someone who knows what our
 * engines are called.
 */

export type ReadSourceId = "runtime-events" | "content-capture" | "local-relay";

export interface ReadSource {
  id: ReadSourceId;
  /** Row heading. */
  name: string;
  /** Short status chip: how the source gets switched on. */
  status: string;
  /** What leaves the customer's process. */
  sends: string;
  /** What reading it lets us tell them. Null when the row lists levels instead. */
  unlocks: string | null;
}

export const READ_SOURCES: readonly ReadSource[] = [
  {
    id: "runtime-events",
    name: "Runtime events",
    status: "On with the SDK",
    sends:
      "What your agent searched for, which tools it was shown, and which it ran. Not its prompts, not what it passed to a tool, not what came back.",
    unlocks:
      "Whether it got it right on the first try, detours, tools that keep showing up but never get picked, padded result lists, tools nobody uses, and steps that always run in a chain.",
  },
  {
    id: "content-capture",
    name: "Content capture",
    status: "Opt-in",
    sends:
      "The rest of the conversation too: what your agent passed to each tool and what came back.",
    unlocks:
      "Which requests travel together, where detours cluster, look-alike tools your agent mixes up, and junk that crowds your result lists.",
  },
  {
    id: "local-relay",
    name: "ratel-local relay",
    status: "You pick the level",
    sends:
      "Running the local relay instead? Its privacy setting decides what leaves your machine. Tool details or Full content unlocks what content capture does.",
    unlocks: null,
  },
];

/** The relay's privacy levels, least to most, as the relay itself names them. */
export const RELAY_PRIVACY_LEVELS = ["Off", "Redacted", "Tool details", "Full content"] as const;

export const CAPTURE_TOGGLE_LABEL = "Include content capture in my snippet";

/** Said once, so nobody feels they must send everything or nothing. */
export const KEEP_BACK_NOTE =
  "Keep parts back if you must; every signal that needs the missing part says so on the page.";

export const FIRST_READING_PROMISE =
  "First reading within 24 hours or 50 turns, whichever comes first.";
