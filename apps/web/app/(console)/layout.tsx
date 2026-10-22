import type { ReactNode } from "react";

export default function ConsoleLayout({ children }: { children: ReactNode }) {
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
        <nav>
          <a href="/" style={{ color: "var(--ratel-ink)", textDecoration: "none" }}>
            Home
          </a>
        </nav>
      </header>
      <main style={{ padding: "32px" }}>{children}</main>
    </div>
  );
}
