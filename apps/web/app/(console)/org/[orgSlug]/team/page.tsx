import { notFound } from "next/navigation";
import { composition } from "@/lib/composition";

export const metadata = { title: "Members" };

/** Who is in the organization: the edition's page, where it has members; a 404 otherwise. */
export default async function OrganizationMembersPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const [{ orgSlug }, ui] = await Promise.all([params, composition.ui?.()]);
  const Members = ui?.MembersPage;
  if (!Members) notFound();
  return <Members slug={orgSlug} />;
}
