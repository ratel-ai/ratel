import type { ReactNode } from "react";
import { getRuntime } from "@/lib/runtime";

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const runtime = await getRuntime();

  return (
    <div style={{ minHeight: "100vh" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 32px",
          borderBottom: "1px solid var(--ratel-indigo)",
        }}
      >
        <strong style={{ fontSize: 20, color: "var(--ratel-indigo)" }}>Ratel</strong>
        <nav style={{ display: "flex", gap: 16 }}>
          <a href="/" style={{ color: "var(--ratel-ink)", textDecoration: "none" }}>
            Home
          </a>
          {runtime.nav.map((item) => (
            <a
              key={item.href}
              href={item.href}
              style={{ color: "var(--ratel-ink)", textDecoration: "none" }}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </header>
      <main style={{ padding: "32px" }}>{children}</main>
    </div>
  );
}
