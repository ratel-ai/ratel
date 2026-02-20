"use client";

import { type FormEvent, useState } from "react";

export default function Contact() {
  const [status, setStatus] = useState<{ type: "success" | "error"; text: string } | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus(null);

    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form));

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const json = await res.json();

      if (!res.ok) {
        setStatus({ type: "error", text: json.error ?? "Something went wrong" });
        return;
      }

      setStatus({ type: "success", text: json.message });
      form.reset();
    } catch {
      setStatus({ type: "error", text: "Network error" });
    }
  }

  return (
    <div>
      <h1>Contact Us</h1>
      <form className="contact-form" onSubmit={handleSubmit}>
        <input name="name" placeholder="Name" required />
        <input name="email" type="email" placeholder="Email" required />
        <textarea name="message" placeholder="Message" required />
        <button type="submit">Send</button>
      </form>
      {status && <p className={`form-message ${status.type}`}>{status.text}</p>}
    </div>
  );
}
