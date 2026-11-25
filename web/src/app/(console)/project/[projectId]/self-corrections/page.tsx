import { SelfCorrectionsRoute } from "./SelfCorrectionsRoute";

export const dynamic = "force-dynamic";
export const metadata = { title: "Self-corrections" };

/** Insights › Self-corrections (`focusedConsole`). */
export default function SelfCorrectionsPage(props: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <SelfCorrectionsRoute address="top-level" {...props} />;
}
