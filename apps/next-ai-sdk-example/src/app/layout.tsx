import type { Metadata } from "next";
import Link from "next/link";
import { ChatWidget } from "@/components/ChatWidget";
import "./globals.css";

export const metadata: Metadata = {
  title: "Next AI SDK Example",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <Link href="/">Home</Link>
          <Link href="/contact">Contact</Link>
        </nav>
        <main>{children}</main>
        <ChatWidget />
      </body>
    </html>
  );
}
