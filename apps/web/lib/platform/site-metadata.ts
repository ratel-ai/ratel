import type { Metadata } from "next";
import type { LinkPreview } from "@/lib/contracts/composition";

/**
 * The root layout's metadata (upstream's `app/layout.tsx` `generateMetadata`): the title template,
 * the description and icon, and the link preview a shared URL unfurls into, with the canonical
 * origin as `metadataBase`.
 */
export function siteMetadata(appName: string, preview: LinkPreview): Metadata {
  const base = metadataBase(preview.origin);
  return {
    ...(base ? { metadataBase: base.url } : {}),
    title: { default: appName, template: `%s · ${appName}` },
    description: preview.description,
    // The mark on its tile: `ratel-mark.png` of @ratel/brand, served from `public/`.
    icons: { icon: "/icon.png" },
    openGraph: {
      title: preview.title,
      description: preview.description,
      ...(base ? { url: base.text } : {}),
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

/**
 * The origin as a URL. One written without a scheme (`ratel.example.com`) is read as https; one
 * that still does not parse leaves the preview without an origin rather than failing every page.
 */
function metadataBase(origin: string): { url: URL; text: string } | null {
  const text = origin.includes("://") ? origin : `https://${origin}`;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? { url, text } : null;
  } catch {
    return null;
  }
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
