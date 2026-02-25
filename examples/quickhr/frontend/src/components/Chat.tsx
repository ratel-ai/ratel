import { useState, useRef, useEffect } from "react";
import { useAgentified } from "@agentified/react";
import type { Message } from "@agentified/react";

function getMessageText(msg: Message): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
  }
  return String(msg.content ?? "");
}

export function Chat() {
  const { messages, sendMessage, isLoading, error } = useAgentified();
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;
    setInput("");
    await sendMessage(trimmed);
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <h3>HR Assistant</h3>
      </div>

      <div className="chat-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`chat-message chat-message-${msg.role}`}>
            <div className="chat-message-role">
              {msg.role === "user" ? "You" : "Assistant"}
            </div>
            <div className="chat-message-content">{getMessageText(msg)}</div>
          </div>
        ))}
        {isLoading && (
          <div className="chat-message chat-message-assistant">
            <div className="chat-message-content chat-typing">Thinking...</div>
          </div>
        )}
        {error && <div className="chat-error">{error}</div>}
        <div ref={messagesEndRef} />
      </div>

      <form className="chat-input-form" onSubmit={handleSubmit}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about employees, time off, payroll..."
          disabled={isLoading}
          className="chat-input"
        />
        <button type="submit" disabled={isLoading || !input.trim()} className="chat-send-btn">
          Send
        </button>
      </form>
    </div>
  );
}
