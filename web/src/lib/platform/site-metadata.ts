import type { Metadata } from "next";
import type { LinkPreview } from "@/lib/contracts/composition";

/**
 * The root layout's metadata (upstream's `app/layout.tsx` `metadata`): the title template, the
 * description and icon, and the link preview a shared URL unfurls into.
 *
 * Static on purpose: nothing here reads the deployment. Its host is runtime config
 * (`APP_PUBLIC_URL`, `BASE_URL`), unset when the image is built. Reading it here would either bake
 * the build's answer into every page or, behind `connection()`, make every route's metadata
 * dynamic, which Cache Components rejects on routes whose content can otherwise prerender. So
 * there is no `metadataBase` and no `og:url`: there are no relative OpenGraph images to resolve,
 * and a link preview takes the URL that was shared.
 */
export function siteMetadata(appName: string, preview: LinkPreview): Metadata {
  return {
    title: { default: appName, template: `%s · ${appName}` },
    description: preview.description,
    // The mark on its tile: `ratel-mark.png` of @ratel/brand, served from `public/`.
    icons: { icon: "/icon.png" },
    openGraph: {
      title: preview.title,
      description: preview.description,
      siteName: preview.siteName,
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: preview.title,
      description: preview.description,
    },
  };
}

/** The preview without an edition: this deployment's name. */
export function defaultLinkPreview(appName: string): LinkPreview {
  return {
    siteName: appName,
    title: appName,
    description: `${appName} breaks down how your agent spends its input token budget across skills, tools, history, memory, and user input, then tells you what to reclaim.`,
  };
}
