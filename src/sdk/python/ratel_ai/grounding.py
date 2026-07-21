"""The re-injection freshness gate for facts — the Python port of `grounding.ts`.

This is the pure decision layer behind "inject a fact only if it isn't already
fresh in the context." Once a fact's body is injected as a transcript message it
*stays* in the history on every later turn, so re-appending it each turn would
duplicate tokens and confuse the model. This module derives what is already
present from the transcript itself — no conversation store, no persistence — and
decides, per fact, whether to (re-)inject. The transcript *is* the ledger:
compaction removing a marker naturally re-arms injection, and a changed body is
caught by a content hash embedded in the marker.

Everything here is a pure function of its inputs (framework-agnostic): a caller
extracts per-message text and renders the chosen injections; this module never
touches a message shape. It has no skill twin — grounding is fact-specific — but
it is the push-path counterpart to the on-demand skill load path.
"""

from __future__ import annotations

import math
import re
from collections.abc import Sequence, Set
from dataclasses import dataclass, field
from typing import Literal

__all__ = [
    "FACT_ID_PATTERN",
    "FactCandidate",
    "GroundOptions",
    "GroundingItem",
    "GroundingResult",
    "InjectionDecision",
    "InjectionDecisionReason",
    "InjectionPolicy",
    "InjectionReason",
    "LedgerEntry",
    "PinTier",
    "fact_hash",
    "grounding_marker",
    "plan_injection",
    "read_grounding_ledger",
]

InjectionReason = Literal["never", "evicted", "mutated", "stale"]
"""Why a fact was chosen for (re-)injection. Mirrors the core `FactInjectReason`.

- ``never`` — not present in the transcript and never injected this session.
- ``evicted`` — injected earlier but its marker is gone now (trimmed / compacted
  out of the window).
- ``mutated`` — present, but the registered body changed since it was injected.
- ``stale`` — present and unchanged, but buried past the freshness window.
"""

InjectionDecisionReason = Literal["never", "evicted", "mutated", "stale", "fresh"]
"""An `InjectionReason`, plus ``fresh`` — a fact left alone because it is still
in context."""

PinTier = Literal["always", "retrieved"]
"""The two tiers a fact's `pin` splits into — always-on vs retrieval-gated."""


@dataclass(frozen=True)
class FactCandidate:
    """A fact under consideration for injection this turn."""

    # The fact id — matched against the transcript ledger and stamped in the marker.
    id: str
    # Content hash of the fact's current body (`fact_hash`); detects mutation.
    hash: str


@dataclass(frozen=True)
class LedgerEntry:
    """One already-injected fact recovered from the transcript by `read_grounding_ledger`."""

    # The injected fact's id.
    id: str
    # The content hash carried in its marker at injection time.
    hash: str
    # How far back the marker sits, in messages from the end of the transcript
    # (`0` = the most recent message). A positional proxy for how fresh the fact
    # still is in the model's attention.
    distance: int


@dataclass(frozen=True)
class InjectionPolicy:
    """Tuning for `plan_injection`."""

    # Re-inject a still-present, unchanged fact once its `LedgerEntry.distance`
    # exceeds this many messages — the lost-in-the-middle re-anchor. Default
    # `inf` (presence-only: never re-inject on distance alone). Leave it at the
    # default for append-only transcripts, where a stale re-inject would
    # duplicate the buried copy rather than move it.
    freshness_window: float = math.inf


@dataclass(frozen=True)
class InjectionDecision:
    """One fact's verdict from `plan_injection`."""

    # The fact id this verdict is for.
    id: str
    # Whether to (re-)inject the fact this turn.
    inject: bool
    # Why — an `InjectionReason` when injecting, ``fresh`` when skipping.
    reason: InjectionDecisionReason


def plan_injection(
    candidates: Sequence[FactCandidate],
    ledger: Sequence[LedgerEntry],
    ever_injected: Set[str] | None = None,
    policy: InjectionPolicy | None = None,
) -> list[InjectionDecision]:
    """Decide, per candidate, whether to inject its body this turn.

    The heart of the freshness gate. Pure and deterministic: the verdicts come
    back in candidate order and depend only on the inputs, so repeated calls in
    one turn never disagree and the result is cache-key stable.

    A candidate is injected when it is absent from the ledger
    (``never``/``evicted``), present with a different hash (``mutated``), or
    present and unchanged but past the freshness window (``stale``); otherwise it
    is skipped as ``fresh``. When the ledger holds more than one marker for an id
    (an append-only re-injection), the freshest occurrence — the smallest
    distance — is the one compared.

    Args:
        candidates: the facts to consider this turn (pinned always-on facts plus
            retrieved hits).
        ledger: the transcript-derived ledger from `read_grounding_ledger`.
        ever_injected: ids injected earlier this session, if the caller tracks
            them. Refines the absent case: absent + previously-injected ⇒
            ``evicted``, absent + unseen ⇒ ``never``. Omit it and every absent
            fact reads as ``never``.
        policy: freshness tuning; see `InjectionPolicy`.

    Returns:
        One `InjectionDecision` per candidate, in the same order.
    """
    window = policy.freshness_window if policy is not None else math.inf

    # Collapse the ledger to the freshest (smallest-distance) marker per id, so a
    # re-injected fact is judged by its most recent copy, not a buried older one.
    freshest: dict[str, LedgerEntry] = {}
    for marker in ledger:
        prev = freshest.get(marker.id)
        if prev is None or marker.distance < prev.distance:
            freshest[marker.id] = marker

    decisions: list[InjectionDecision] = []
    for candidate in candidates:
        entry = freshest.get(candidate.id)
        if entry is None:
            if ever_injected is not None and candidate.id in ever_injected:
                decisions.append(InjectionDecision(candidate.id, True, "evicted"))
            else:
                decisions.append(InjectionDecision(candidate.id, True, "never"))
        elif entry.hash != candidate.hash:
            decisions.append(InjectionDecision(candidate.id, True, "mutated"))
        elif entry.distance > window:
            decisions.append(InjectionDecision(candidate.id, True, "stale"))
        else:
            decisions.append(InjectionDecision(candidate.id, False, "fresh"))
    return decisions


@dataclass(frozen=True)
class GroundingItem:
    """One fact the grounding pass decided to (re-)inject this turn."""

    # The fact id.
    id: str
    # The fact body to render into the transcript.
    body: str
    # The marker to embed alongside the body so later turns dedupe it (`grounding_marker`).
    marker: str
    # Why it was injected.
    reason: InjectionReason
    # Which tier it came from.
    pin: PinTier


@dataclass(frozen=True)
class GroundingResult:
    """The outcome of a grounding pass — what to inject and what was left fresh."""

    # Facts to render into the transcript, always-on tier first.
    inject: list[GroundingItem] = field(default_factory=list)
    # Ids left alone because they are still fresh in the context (observability).
    skipped: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class GroundOptions:
    """Per-call options for a grounding pass."""

    # Max retrieval-gated facts to consider (capped at 50, default 3).
    top_k: int | None = None
    # Override the freshness window for this pass — see `InjectionPolicy.freshness_window`.
    freshness_window: float | None = None


# FNV-1a 64-bit constants, masked to 64 bits each multiply.
_FNV_OFFSET = 0xCBF29CE484222325
_FNV_PRIME = 0x100000001B3
_U64_MASK = 0xFFFFFFFFFFFFFFFF


def fact_hash(body: str) -> str:
    """Return a short, stable content hash of a fact's body.

    The change-detection token embedded in the marker. FNV-1a (64-bit),
    dependency-free: this is *not* a security boundary, so a fast non-crypto hash
    is deliberate. A collision merely means a changed fact is not re-injected
    (stale content, never a safety issue). Only the ``body`` is hashed: the body
    is what sits in the context, so a change to ranking-only metadata never
    forces a re-inject. Self-consistent within a runtime — the SDK reads back
    only markers it wrote — so the algorithm need not match other SDKs
    byte-for-byte (a code point per Python character here, versus a UTF-16 code
    unit in the TS SDK).

    Args:
        body: the fact body that gets injected.

    Returns:
        A fixed-width 16-char lowercase-hex digest.
    """
    digest = _FNV_OFFSET
    for char in body:
        digest = ((digest ^ ord(char)) * _FNV_PRIME) & _U64_MASK
    return format(digest, "016x")


FACT_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]+$")
"""The set of fact ids a grounding marker's id may use.

Enforced at the catalog boundary so a marker is always unambiguously parseable
(no whitespace or the marker delimiters can appear inside an id).
"""

# A single-line, unobtrusive marker the injected message carries so the fact can
# be recovered from the transcript. `id` is delimiter-free (validated by
# FACT_ID_PATTERN); `v` is the hex content hash.
_MARKER_OPEN = "⟦ratel:fact"
_MARKER_CLOSE = "⟧"
_MARKER_RE = re.compile(r"⟦ratel:fact id=([A-Za-z0-9._:-]+) v=([0-9a-f]+)⟧")


def grounding_marker(id: str, hash: str) -> str:
    """Render the grounding marker that tags an injected fact so later turns dedupe it.

    Pair it with the fact body in the message the caller appends.

    Args:
        id: the fact id; must match `FACT_ID_PATTERN`.
        hash: the body hash from `fact_hash`.

    Returns:
        The marker string, e.g. ``⟦ratel:fact id=shop-address v=1a2b3c4d5e6f⟧``.
    """
    return f"{_MARKER_OPEN} id={id} v={hash}{_MARKER_CLOSE}"


def read_grounding_ledger(texts: Sequence[str]) -> list[LedgerEntry]:
    """Rebuild the injection ledger from a transcript.

    The stateless counterpart to `grounding_marker`. Scans each message's
    already-extracted text for grounding markers and returns one `LedgerEntry`
    per id, keeping the freshest (nearest-to-end) occurrence when a fact was
    injected more than once.

    Args:
        texts: per-message text in transcript order (oldest first, newest last).

    Returns:
        The recovered ledger, freshest-per-id; ``[]`` when no markers are present.
    """
    freshest: dict[str, LedgerEntry] = {}
    n = len(texts)
    for i, text in enumerate(texts):
        distance = n - 1 - i
        for match in _MARKER_RE.finditer(text):
            fact_id, content_hash = match.group(1), match.group(2)
            prev = freshest.get(fact_id)
            if prev is None or distance < prev.distance:
                freshest[fact_id] = LedgerEntry(fact_id, content_hash, distance)
    return list(freshest.values())
