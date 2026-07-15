"use client";

import { useEffect, useState } from "react";
import { Chat } from "@/components/Chat";
import { CatalogPanel } from "@/components/CatalogPanel";
import { SuggestionsPanel } from "@/components/SuggestionsPanel";

function randomUser() {
  return `user-${Math.random().toString(36).slice(2, 6)}`;
}

export default function Home() {
  // Start every page load on a fresh opaque end-user id so repeated demo
  // runs never trip Cloud's per-(intent, user) suggestion dedup. Assigned
  // after mount — random ids in SSR output cause hydration mismatches.
  const [user, setUser] = useState("");
  useEffect(() => setUser(randomUser()), []);
  const [draft, setDraft] = useState<string | null>(null);

  const commitDraft = () => {
    if (draft !== null && draft.trim()) setUser(draft.trim());
    setDraft(null);
  };

  if (!user) return null;

  return (
    <div className="shell">
      <header className="topbar">
        <h1>
          <span>ratel</span> · end-user skills demo
        </h1>
        <div className="spacer" />
        <div className="userbox">
          <label htmlFor="user">end-user</label>
          <input
            id="user"
            value={draft ?? user}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          <button
            type="button"
            className="small"
            title="Switch to a fresh end-user (fresh chat, fresh telemetry)"
            onClick={() => {
              setDraft(null);
              setUser(randomUser());
            }}
          >
            ↻ new
          </button>
        </div>
      </header>

      <div className="grid">
        {/* key= remounts the chat + suggestion state when the end-user changes */}
        <div className="panel chat">
          <Chat key={user} user={user} />
        </div>
        <div>
          <CatalogPanel />
          <SuggestionsPanel key={user} user={user} />
        </div>
      </div>
    </div>
  );
}
