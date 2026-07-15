"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
} from "ai";

const STARTERS = [
  "Write unit tests for my new parser function",
  "Draft a customer refund policy document",
  "Review my latest pull request",
];

/**
 * The end-user's chat with the AI SDK agent. Every substantive ask makes the
 * agent call `search_skills` (a real, traced BM25 search of the catalog
 * synced from Ratel Cloud) and, on a match, `use_skill` (a real, attributed
 * skill_invoke) — the tool chips below each answer show it happening.
 */
export function Chat({ user }: { user: string }) {
  const [input, setInput] = useState("");
  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat", body: { user } }),
    [user],
  );
  const { messages, sendMessage, status, error } = useChat({ transport });
  const busy = status === "submitted" || status === "streaming";

  const send = (text: string): boolean => {
    const t = text.trim();
    if (!t || busy) return false;
    sendMessage({ text: t });
    return true;
  };

  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  return (
    <>
      <h2>
        chat <span className="count">{user}</span>
      </h2>
      <p className="sub">
        an AI SDK agent whose skill catalog is synced live from Ratel Cloud — every
        search/invoke is real telemetry for this end-user
      </p>

      <div className="chat-scroll">
        {messages.length === 0 && (
          <div className="empty">
            Ask for something a skill covers — or something the catalog can&apos;t do yet,
            then generate suggestions on the right.
            <div className="starters">
              {STARTERS.map((s) => (
                <button key={s} type="button" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="msg-user">
              {m.parts.map((p, i) => (p.type === "text" ? <span key={i}>{p.text}</span> : null))}
            </div>
          ) : (
            <div key={m.id} className="msg-assistant">
              {m.parts.map((p, i) => {
                if (p.type === "text" && p.text.trim()) {
                  return (
                    <div key={i} className="bubble">
                      {p.text}
                    </div>
                  );
                }
                if (isToolUIPart(p)) return <ToolChip key={i} part={p} />;
                return null;
              })}
            </div>
          ),
        )}
        <div ref={endRef} />
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          if (send(input)) setInput("");
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`Ask as ${user}…`}
          disabled={false}
        />
        <button type="submit" className="primary" disabled={busy || !input.trim()}>
          {busy ? "…" : "Send"}
        </button>
      </form>
      <div className={`status-line${error ? " error" : ""}`}>
        {error ? `error: ${error.message}` : busy ? "the agent is working…" : ""}
      </div>
    </>
  );
}

function ToolChip({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  const name = part.type === "dynamic-tool" ? part.toolName : part.type.replace(/^tool-/, "");
  const running = part.state === "input-streaming" || part.state === "input-available";
  return (
    <span className="toolchip">
      <span>{running ? <span className="spin">◌</span> : "▸"}</span>
      <span className="tname">{name}</span>
      <span className="tout">{describe(name, part)}</span>
    </span>
  );
}

function describe(name: string, part: ToolUIPart | DynamicToolUIPart): string {
  const input = (part.input ?? {}) as Record<string, unknown>;
  if (part.state === "output-error") return `failed: ${part.errorText}`;
  if (part.state !== "output-available") {
    return typeof input.query === "string" ? `"${input.query}"` : "…";
  }
  const output = part.output as Record<string, unknown> | undefined;
  if (name === "search_skills") {
    const hits = (output?.hits ?? []) as Array<{ name: string; score: number }>;
    const q = typeof input.query === "string" ? `"${input.query}" → ` : "";
    if (hits.length === 0) return `${q}no matching skill`;
    return q + hits.map((h) => `${h.name} (${h.score})`).join(", ");
  }
  if (name === "use_skill") {
    const skill = output?.name;
    return typeof skill === "string" ? `loaded "${skill}" instructions` : "loaded instructions";
  }
  return "done";
}
