import { Button } from "@ratel/brand/button";

export default function AdminPage() {
  return (
    <main style={{ padding: 32, fontFamily: "var(--ratel-font)", color: "var(--ratel-ink)" }}>
      <h1 style={{ margin: "0 0 12px", fontSize: 32, color: "var(--ratel-indigo)" }}>Admin</h1>
      <p style={{ margin: "0 0 20px" }}>
        Cloud-only administration surface. Shared chrome stays edition-agnostic.
      </p>
      <Button>Invite member</Button>
    </main>
  );
}
