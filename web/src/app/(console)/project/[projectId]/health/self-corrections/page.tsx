import { SelfCorrectionsRoute } from "../../self-corrections/SelfCorrectionsRoute";

export const dynamic = "force-dynamic";
export const metadata = { title: "Self-corrections" };

/** Agent health › Self-corrections, until `focusedConsole` moves it to Insights. */
export default function SelfCorrectionsPage(props: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <SelfCorrectionsRoute address="health" {...props} />;
}
