import { BrandedNotFound } from "@/components/console/errors/BrandedNotFound";
import { ScopedTraceListLink } from "@/components/console/errors/ScopedTraceListLink";

export default function ScopedTraceNotFound() {
  return <BrandedNotFound action={<ScopedTraceListLink />} />;
}
