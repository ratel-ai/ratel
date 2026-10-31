import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { APP_NAME, appConfigScript } from "@/lib/platform/app-config";
import "./globals.css";

export const metadata: Metadata = {
  title: APP_NAME,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: our own config, escaped by appConfigScript */}
        <script dangerouslySetInnerHTML={{ __html: appConfigScript() }} />
      </head>
      <body className="m-0 bg-app font-sans text-fg antialiased">{children}</body>
    </html>
  );
}
