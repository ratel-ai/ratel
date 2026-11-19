import type { Metadata } from "next";
import type { LinkPreview } from "@/lib/contracts/composition";

/**
 * The root layout's metadata (upstream's `app/layout.tsx` `generateMetadata`): the title template,
 * the description and icon, and the link preview a shared URL unfurls into, with the canonical
 * origin as `metadataBase`.
 */
export function siteMetadata(appName: string, preview: LinkPreview): Metadata {
  return {
    metadataBase: new URL(preview.origin),
    title: { default: appName, template: `%s · ${appName}` },
    description: preview.description,
    // The mark on its tile: `ratel-mark.png` of @ratel/brand, served from `public/`.
    icons: { icon: "/icon.png" },
    openGraph: {
      title: preview.title,
      description: preview.description,
      url: preview.origin,
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

/** The preview without an edition: this deployment's name and origin. */
export function defaultLinkPreview(appName: string, baseUrl: string): LinkPreview {
  return {
    origin: baseUrl,
    siteName: appName,
    title: appName,
    description: `${appName} breaks down how your agent spends its input token budget across skills, tools, history, memory, and user input, then tells you what to reclaim.`,
  };
}
