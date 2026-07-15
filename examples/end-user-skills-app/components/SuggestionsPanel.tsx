"use client";

import { useState } from "react";

interface Suggestion {
  id: string;
  signalKind: string;
  rationale: string;
  status: string;
  endUserId: string | null;
  patch: { name?: string; description?: string } | null;
  createdSkillId?: string | null;
}

type ActionState =
  | { kind: "idle" }
  | { kind: "busy"; action: "approve" | "reject" }
  | { kind: "approved"; createdSkillId: string | null }
  | { kind: "rejected" }
  | { kind: "error"; message: string };

/**
 * The per-user skill suggestion flow: flush this user's traces, run Cloud's
 * categorize + generate pipeline (real model call drafts the skill), then
 * review the proposals scoped to this end-user — approve or reject, live.
 */
export function SuggestionsPanel({ user }: { user: string }) {
  const [generating, setGenerating] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [actions, setActions] = useState<Record<string, ActionState>>({});

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/suggestions/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user }),
      });
      const data = (await res.json()) as { error?: string; suggestions?: Suggestion[] };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSuggestions(data.suggestions ?? []);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "generation failed");
    } finally {
      setGenerating(false);
    }
  };

  const act = async (id: string, action: "approve" | "reject") => {
    setActions((a) => ({ ...a, [id]: { kind: "busy", action } }));
    try {
      const res = await fetch(`/api/suggestions/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
      });
      const data = (await res.json()) as { error?: string; suggestion?: Suggestion };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setActions((a) => ({
        ...a,
        [id]:
          action === "approve"
            ? { kind: "approved", createdSkillId: data.suggestion?.createdSkillId ?? null }
            : { kind: "rejected" },
      }));
    } catch (err) {
      setActions((a) => ({
        ...a,
        [id]: { kind: "error", message: err instanceof Error ? err.message : "failed" },
      }));
    }
  };

  return (
    <div className="panel">
      <h2>
        skill suggestions <span className="count">{user}</span>
      </h2>
      <p className="sub">
        Cloud turns this user&apos;s uncovered asks into per-user skill proposals
      </p>

      <button type="button" className="primary" onClick={() => void generate()} disabled={generating}>
        {generating ? (
          <>
            <span className="spin">◌</span> analyzing usage… (flush → categorize → draft)
          </>
        ) : (
          "Generate suggestions from my usage"
        )}
      </button>

      {error && <div className="status-line error">error: {error}</div>}

      {loaded && suggestions.length === 0 && !error && (
        <div className="status-line">
          no per-user proposals yet — chat an ask the catalog can&apos;t cover first
        </div>
      )}

      {suggestions.map((s) => {
        const state = actions[s.id] ?? { kind: "idle" };
        return (
          <div key={s.id} className="sugg-card">
            <span className="kind">{s.signalKind.replace(/_/g, " ")}</span>
            <div className="rationale">{s.rationale}</div>
            {s.patch?.name && (
              <div className="draft">
                <span className="name">{s.patch.name}</span>
                {s.patch.description && <div>{s.patch.description}</div>}
              </div>
            )}

            {state.kind === "idle" && (
              <div className="sugg-actions">
                <button type="button" className="primary small" onClick={() => void act(s.id, "approve")}>
                  Approve
                </button>
                <button type="button" className="danger small" onClick={() => void act(s.id, "reject")}>
                  Reject
                </button>
              </div>
            )}
            {state.kind === "busy" && (
              <div className="sugg-result">
                <span className="spin">◌</span> {state.action}ing…
              </div>
            )}
            {state.kind === "approved" && (
              <>
                <div className="sugg-result ok">
                  ✓ approved — skill created{state.createdSkillId ? ` (${state.createdSkillId.slice(0, 8)}…)` : ""}
                </div>
                <div className="boundary-note">
                  the new skill is a draft scoped to {user} in Cloud — it won&apos;t appear in
                  the published catalog panel until published (and user-scoped skills don&apos;t
                  sync to SDK hosts yet, by design)
                </div>
              </>
            )}
            {state.kind === "rejected" && <div className="sugg-result no">✗ rejected</div>}
            {state.kind === "error" && (
              <div className="sugg-result no">failed: {state.message}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
