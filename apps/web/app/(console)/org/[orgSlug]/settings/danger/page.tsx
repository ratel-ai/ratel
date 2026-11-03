import { notFound } from "next/navigation";
import { composition } from "@/lib/composition";

export const metadata = { title: "Organization settings" };

/** Deleting the organization: the edition's page, where it has one; a 404 otherwise. */
export default async function OrganizationDangerPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const [{ orgSlug }, ui] = await Promise.all([params, composition.ui?.()]);
  const Danger = ui?.OrganizationDangerSettings;
  if (!Danger) notFound();
  return <Danger slug={orgSlug} />;
}
