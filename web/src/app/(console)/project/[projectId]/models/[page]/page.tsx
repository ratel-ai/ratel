import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { composition } from "@/lib/composition";

type Params = Promise<{ projectId: string; page: string }>;

async function editionPage(page: string) {
  const pages = (await composition.ui?.())?.ProjectPages;
  return pages && Object.hasOwn(pages, page) ? pages[page] : undefined;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { page } = await params;
  return { title: (await editionPage(page))?.title };
}

/** `/project/<id>/models/<page>`: the edition's page for that key, where it has one; a 404 otherwise. */
export default async function EditionProjectRoute({ params }: { params: Params }) {
  const { projectId, page } = await params;
  const entry = await editionPage(page);
  if (!entry) notFound();
  return <entry.Page projectId={projectId} />;
}
