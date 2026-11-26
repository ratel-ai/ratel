import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Fragment, type ReactNode } from "react";
import { composition } from "@/lib/composition";
import { APP_NAME, appConfigScript } from "@/lib/platform/app-config";
import { defaultLinkPreview, siteMetadata } from "@/lib/platform/site-metadata";
import "./globals.css";

/**
 * Static: the edition's link-preview words, else this deployment's name. Nothing in it reads the
 * request or the deployment's host (`site-metadata.ts` says why).
 */
export async function generateMetadata(): Promise<Metadata> {
  const preview = (await composition.ui?.())?.linkPreview ?? defaultLinkPreview(APP_NAME);
  return siteMetadata(APP_NAME, preview);
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="m-0 bg-app font-sans text-fg antialiased">
        <RequestRoot>{children}</RequestRoot>
      </body>
    </html>
  );
}

/**
 * What the root reads per request: the server's config for the browser and the edition's provider.
 * A self-hoster configures the running image, so neither may be prerendered at build: this waits
 * for a request. The script comes first, so it runs before anything after it hydrates and reads
 * `window.__RATEL_APP_CONFIG__`. Without an edition (the open-source one) the script is still
 * written, around no provider.
 *
 * Not in a `<Suspense>` yet: with Cache Components off, one here would flush the shell before the
 * page renders, so a page's `notFound()` would answer HTTP 200 instead of 404. Turning Cache
 * Components on wraps this in `<Suspense fallback={null}>`, so a static shell stops at `<body>`,
 * and has to keep those 404s.
 */
async function RequestRoot({ children }: { children: ReactNode }) {
  await connection();
  const ui = await composition.ui?.();
  const Provider = ui?.RootProvider ?? Fragment;
  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: our own config, escaped by appConfigScript */}
      <script dangerouslySetInnerHTML={{ __html: appConfigScript() }} />
      <Provider>{children}</Provider>
    </>
  );
}
