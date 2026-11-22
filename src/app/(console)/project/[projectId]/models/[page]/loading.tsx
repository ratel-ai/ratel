import { composition } from "@/lib/composition";

/**
 * An edition project page loading: the edition's skeleton (upstream's `ApiSkeleton`, its
 * Embeddings and Tool Picker `loading.tsx`), so the project Overview's skeleton never flashes
 * first. Nothing without one.
 */
export default async function EditionProjectPageLoading() {
  const Skeleton = (await composition.ui?.())?.ProjectPageSkeleton;
  return Skeleton ? <Skeleton /> : null;
}
