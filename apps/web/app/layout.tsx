import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@ratel/brand/tokens.css";

export const metadata: Metadata = {
  title: "Ratel",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          backgroundColor: "var(--ratel-paper)",
          color: "var(--ratel-ink)",
          fontFamily: "var(--ratel-font)",
        }}
      >
        {children}
      </body>
    </html>
  );
}
