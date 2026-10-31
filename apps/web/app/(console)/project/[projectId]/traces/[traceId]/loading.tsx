import { TraceSkeleton } from "@/components/console/traces/TracesSkeletons";

export default function TraceDetailLoading() {
  return (
    <>
      <span role="status" className="sr-only">
        Loading trace…
      </span>
      <TraceSkeleton />
    </>
  );
}
