import { redirect } from "next/navigation";
import { composition } from "@/lib/composition";

export const metadata = { title: "Organizations" };

/**
 * The edition's organizations directory, where it has several; with one organization the
 * organizations list is the console's entry.
 */
export default async function OrganizationsPage() {
  const Organizations = (await composition.ui?.())?.OrganizationsPage;
  if (!Organizations) redirect("/");
  return <Organizations />;
}
