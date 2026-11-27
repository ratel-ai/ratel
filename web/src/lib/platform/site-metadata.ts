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
      ...(preview.image ? { images: [preview.image] } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title: preview.title,
      description: preview.description,
      ...(preview.image ? { images: [preview.image] } : {}),
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

/**
 * The preview without an edition: this deployment's name and origin, ratel.sh's description, and
 * the social card `ratel-og.png` of @ratel/brand, served from `public/og.png`.
 */
export function defaultLinkPreview(appName: string, baseUrl: string): LinkPreview {
  return {
    origin: baseUrl,
    siteName: appName,
    title: appName,
    description: `${appName} finds problems, fixes them and runs evals on your agent, for higher accuracy, lower latency and no wasted tokens, turn after turn.`,
    image: "/og.png",
  };
}
