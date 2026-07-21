/**
 * The re-injection freshness gate for facts — the pure decision layer behind
 * "inject a fact only if it isn't already fresh in the context."
 *
 * Once a fact's body is injected as a transcript message it *stays* in the
 * history on every later turn, so re-appending it each turn would duplicate
 * tokens and confuse the model. This module derives what is already present
 * from the transcript itself — no conversation store, no persistence — and
 * decides, per fact, whether to (re-)inject. The transcript *is* the ledger:
 * compaction removing a marker naturally re-arms injection, and a changed body
 * is caught by a content hash embedded in the marker.
 *
 * Everything here is a pure function of its inputs (framework-agnostic): the
 * adapter extracts per-message text and renders the chosen injections; this
 * module never touches a message shape.
 */

/**
 * Why a fact was chosen for (re-)injection. Mirrors the core
 * `FactInjectReason` trace enum.
 *
 * - `never` — not present in the transcript and never injected this session.
 * - `evicted` — injected earlier but its marker is gone now (trimmed /
 *   compacted out of the window).
 * - `mutated` — present, but the registered body changed since it was injected.
 * - `stale` — present and unchanged, but buried past the freshness window.
 */
export type InjectionReason = "never" | "evicted" | "mutated" | "stale";

/** The verdict `fresh` marks a fact left alone because it is still in context. */
export type InjectionDecisionReason = InjectionReason | "fresh";

/**
 * The two tiers a fact's `pin` splits into. A const object rather than a TS
 * `enum` (matching `SearchTarget`/`Origin` in `@ratel-ai/telemetry`): reference
 * it symbolically as `Pin.Always`, and the plain wire strings `"always"` /
 * `"retrieved"` stay assignable to it.
 */
export const Pin = {
  /** Always-on: injected every applicable turn, never dropped. */
  Always: "always",
  /** Retrieval-gated (the default): surfaced only when a query ranks it in. */
  Retrieved: "retrieved",
} as const;
export type Pin = (typeof Pin)[keyof typeof Pin];

/** A fact under consideration for injection this turn. */
export interface FactCandidate {
  /** The fact id — matched against the transcript ledger and stamped in the marker. */
  id: string;
  /** Content hash of the fact's current body ({@link factHash}); detects mutation. */
  hash: string;
}

/** One already-injected fact recovered from the transcript by {@link readGroundingLedger}. */
export interface LedgerEntry {
  /** The injected fact's id. */
  id: string;
  /** The content hash carried in its marker at injection time. */
  hash: string;
  /**
   * How far back the marker sits, in messages from the end of the transcript
   * (`0` = the most recent message). A positional proxy for how fresh the fact
   * still is in the model's attention.
   */
  distance: number;
}

/** Tuning for {@link planInjection}. */
export interface InjectionPolicy {
  /**
   * Re-inject a still-present, unchanged fact once its {@link LedgerEntry.distance}
   * exceeds this many messages — the lost-in-the-middle re-anchor. Default
   * `Infinity` (presence-only: never re-inject on distance alone). Leave it at
   * the default for append-only transcripts, where a stale re-inject would
   * duplicate the buried copy rather than move it.
   */
  freshnessWindow?: number;
}

/** Input to {@link planInjection}. */
export interface PlanInjectionInput {
  /** The facts to consider this turn (pinned always-on facts plus retrieved hits). */
  candidates: readonly FactCandidate[];
  /** The transcript-derived ledger from {@link readGroundingLedger}. */
  ledger: readonly LedgerEntry[];
  /**
   * Ids injected earlier this session, if the caller tracks them. Refines the
   * absent case: absent + previously-injected ⇒ `evicted`, absent + unseen ⇒
   * `never`. Omit it and every absent fact reads as `never`.
   */
  everInjected?: ReadonlySet<string>;
  /** Freshness tuning; see {@link InjectionPolicy}. */
  policy?: InjectionPolicy;
}

/** One fact's verdict from {@link planInjection}. */
export interface InjectionDecision {
  /** The fact id this verdict is for. */
  id: string;
  /** Whether to (re-)inject the fact this turn. */
  inject: boolean;
  /** Why — an {@link InjectionReason} when injecting, `fresh` when skipping. */
  reason: InjectionDecisionReason;
}

/**
 * Decide, per candidate, whether to inject its body this turn — the heart of
 * the freshness gate. Pure and deterministic: the verdicts come back in
 * candidate order and depend only on the inputs, so repeated calls in one turn
 * never disagree and the result is cache-key stable.
 *
 * A candidate is injected when it is absent from the ledger (`never`/`evicted`),
 * present with a different hash (`mutated`), or present and unchanged but past
 * the freshness window (`stale`); otherwise it is skipped as `fresh`. When the
 * ledger holds more than one marker for an id (an append-only re-injection), the
 * freshest occurrence — the smallest distance — is the one compared.
 *
 * @param input - Candidates, the transcript ledger, optional session bookkeeping, and policy.
 * @returns One {@link InjectionDecision} per candidate, in the same order.
 */
export function planInjection(input: PlanInjectionInput): InjectionDecision[] {
  const window = input.policy?.freshnessWindow ?? Number.POSITIVE_INFINITY;
  const ever = input.everInjected;

  // Collapse the ledger to the freshest (smallest-distance) marker per id, so a
  // re-injected fact is judged by its most recent copy, not a buried older one.
  const freshest = new Map<string, LedgerEntry>();
  for (const entry of input.ledger) {
    const prev = freshest.get(entry.id);
    if (!prev || entry.distance < prev.distance) freshest.set(entry.id, entry);
  }

  return input.candidates.map((candidate): InjectionDecision => {
    const entry = freshest.get(candidate.id);
    if (!entry) {
      const reason: InjectionReason = ever?.has(candidate.id) ? "evicted" : "never";
      return { id: candidate.id, inject: true, reason };
    }
    if (entry.hash !== candidate.hash) {
      return { id: candidate.id, inject: true, reason: "mutated" };
    }
    if (entry.distance > window) {
      return { id: candidate.id, inject: true, reason: "stale" };
    }
    return { id: candidate.id, inject: false, reason: "fresh" };
  });
}

/** One fact the grounding pass decided to (re-)inject this turn. */
export interface GroundingItem {
  /** The fact id. */
  id: string;
  /** The fact body to render into the transcript. */
  body: string;
  /** The marker to embed alongside the body so later turns dedupe it ({@link groundingMarker}). */
  marker: string;
  /** Why it was injected. */
  reason: InjectionReason;
  /** Which tier it came from. */
  pin: Pin;
}

/** The outcome of a grounding pass — what to inject and what was left fresh. */
export interface GroundingResult {
  /** Facts to render into the transcript, always-on tier first. */
  inject: GroundingItem[];
  /** Ids left alone because they are still fresh in the context (observability). */
  skipped: string[];
}

/** Per-call options for a grounding pass. */
export interface GroundOptions {
  /** Max retrieval-gated facts to consider (capped at 50, default 3). */
  topK?: number;
  /** Override the freshness window for this pass — see {@link InjectionPolicy.freshnessWindow}. */
  freshnessWindow?: number;
}

// FNV-1a 64-bit constants (BigInt), masked to 64 bits each multiply.
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64_MASK = 0xffffffffffffffffn;

/**
 * A short, stable content hash of a fact's body — the change-detection token
 * embedded in the marker. FNV-1a (64-bit), dependency-free: this is *not* a
 * security boundary, so a fast non-crypto hash is deliberate. A collision
 * merely means a changed fact is not re-injected (stale content, never a
 * safety issue). Only the `body` is hashed: the body is what sits in the
 * context, so a change to ranking-only metadata never forces a re-inject.
 * Self-consistent within a runtime — the SDK reads back only markers it wrote —
 * so the algorithm need not match other SDKs byte-for-byte.
 *
 * @param body - The fact body that gets injected.
 * @returns A fixed-width 16-char lowercase-hex digest.
 */
export function factHash(body: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < body.length; i++) {
    hash = ((hash ^ BigInt(body.charCodeAt(i))) * FNV_PRIME) & U64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * The set of fact ids a grounding marker's id may use. Enforced at the catalog
 * boundary so a marker is always unambiguously parseable (no whitespace or the
 * marker delimiters can appear inside an id).
 */
export const FACT_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

// A single-line, unobtrusive marker the injected message carries so the fact can
// be recovered from the transcript. `id` is delimiter-free (validated by
// FACT_ID_PATTERN); `v` is the hex content hash.
const MARKER_OPEN = "⟦ratel:fact";
const MARKER_CLOSE = "⟧";
const MARKER_RE = /⟦ratel:fact id=([A-Za-z0-9._:-]+) v=([0-9a-f]+)⟧/g;

/**
 * Render the grounding marker that tags an injected fact so later turns can
 * dedupe it. Pair it with the fact body in the message the adapter appends.
 *
 * @param id - The fact id; must match {@link FACT_ID_PATTERN}.
 * @param hash - The body hash from {@link factHash}.
 * @returns The marker string, e.g. `⟦ratel:fact id=shop-address v=1a2b3c4d5e6f⟧`.
 */
export function groundingMarker(id: string, hash: string): string {
  return `${MARKER_OPEN} id=${id} v=${hash}${MARKER_CLOSE}`;
}

/**
 * Rebuild the injection ledger from a transcript — the stateless counterpart to
 * {@link groundingMarker}. Scans each message's already-extracted text for
 * grounding markers and returns one {@link LedgerEntry} per id, keeping the
 * freshest (nearest-to-end) occurrence when a fact was injected more than once.
 *
 * @param texts - Per-message text in transcript order (oldest first, newest last).
 * @returns The recovered ledger, freshest-per-id; `[]` when no markers are present.
 */
export function readGroundingLedger(texts: readonly string[]): LedgerEntry[] {
  const freshest = new Map<string, LedgerEntry>();
  const n = texts.length;
  for (let i = 0; i < n; i++) {
    const distance = n - 1 - i;
    // Fresh lastIndex per message: MARKER_RE is a shared global regex.
    MARKER_RE.lastIndex = 0;
    for (let m = MARKER_RE.exec(texts[i]); m !== null; m = MARKER_RE.exec(texts[i])) {
      const [, id, hash] = m;
      const prev = freshest.get(id);
      if (!prev || distance < prev.distance) freshest.set(id, { id, hash, distance });
    }
  }
  return [...freshest.values()];
}
