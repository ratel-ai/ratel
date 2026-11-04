import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import { Fragment, type ReactNode } from "react";
import { composition } from "@/lib/composition";
import { APP_NAME, appConfigScript } from "@/lib/platform/app-config";
import "./globals.css";

export const metadata: Metadata = {
  title: APP_NAME,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const ui = await composition.ui?.();
  const Provider = ui?.RootProvider ?? Fragment;
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: our own config, escaped by appConfigScript */}
        <script dangerouslySetInnerHTML={{ __html: appConfigScript() }} />
      </head>
      <body className="m-0 bg-app font-sans text-fg antialiased">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}

// ci-scope-proof
