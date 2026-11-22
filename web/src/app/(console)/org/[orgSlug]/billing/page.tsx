import { notFound } from "next/navigation";
import { composition } from "@/lib/composition";

export const metadata = { title: "Billing" };

/** The organization's plan and credits: the edition's page, where it has one; a 404 otherwise. */
export default async function OrganizationBillingRoute({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ orgSlug }, ui] = await Promise.all([params, composition.ui?.()]);
  const Billing = ui?.OrganizationBillingPage;
  if (!Billing) notFound();
  return <Billing slug={orgSlug} searchParams={searchParams} />;
}
