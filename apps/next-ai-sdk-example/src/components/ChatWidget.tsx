"use client";

import { useState, useRef, useEffect } from "react";
import { useChat } from "@ai-sdk/react";

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const messagesEnd = useRef<HTMLDivElement>(null);

  const { messages, sendMessage, status } = useChat();

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    sendMessage({ text: input });
    setInput("");
  }

  return (
    <>
      <button className="chat-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? "\u00d7" : "\u{1f4ac}"}
      </button>

      {open && (
        <div className="chat-panel">
          <div className="chat-header">App Agent</div>

          <div className="chat-messages">
            {messages.map((m) => (
              <div key={m.id} className={`chat-msg ${m.role}`}>
                {m.parts
                  .filter((p) => p.type === "text")
                  .map((p, i) => (
                    <span key={i}>{p.type === "text" ? p.text : null}</span>
                  ))}
              </div>
            ))}
            <div ref={messagesEnd} />
          </div>

          <form className="chat-input-row" onSubmit={handleSubmit}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask the agent..."
              disabled={status === "streaming"}
            />
            <button type="submit" disabled={status === "streaming"}>
              Send
            </button>
          </form>
        </div>
      )}
    </>
  );
}
