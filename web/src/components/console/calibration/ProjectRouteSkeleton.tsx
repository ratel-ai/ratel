type ProjectRouteSkeletonProps = {
  variant?: "detail" | "overview" | "settings" | "table" | "teaser";
};

const ROWS = Array.from({ length: 7 });

export function ProjectRouteSkeleton({ variant = "table" }: ProjectRouteSkeletonProps) {
  return (
    <div role="status" aria-busy="true" className="mx-auto w-full max-w-6xl">
      <span className="sr-only">Loading page…</span>
      <div aria-hidden className="flex flex-col gap-6 motion-safe:animate-pulse">
        <SkeletonHeader />
        {variant === "overview" && <OverviewBody />}
        {variant === "table" && <TableBody />}
        {variant === "detail" && <DetailBody />}
        {variant === "settings" && <SettingsBody />}
        {variant === "teaser" && <TeaserBody />}
      </div>
    </div>
  );
}

function SkeletonHeader() {
  return (
    <div className="pixel-header flex flex-wrap items-end justify-between gap-4 border-b border-forest-300 pb-7">
      <div>
        <div className="h-2.5 w-24 rounded bg-forest-300/50" />
        <div className="mt-2 h-8 w-64 max-w-[70vw] rounded bg-forest-300/65" />
        <div className="mt-3 h-3 w-80 max-w-[82vw] rounded bg-forest-300/35" />
      </div>
      <div className="h-9 w-32 rounded-lg border border-forest-300 bg-forest-600/40" />
    </div>
  );
}

function OverviewBody() {
  return (
    <>
      <div className="grid gap-px overflow-hidden rounded-xl border border-forest-300 bg-forest-300 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="h-40 bg-forest-600/40 p-5">
            <div className="h-8 w-8 rounded-lg bg-forest-300/45" />
            <div className="mt-5 h-3 w-28 rounded bg-forest-300/55" />
            <div className="mt-3 h-2.5 w-3/4 rounded bg-forest-300/30" />
          </div>
        ))}
      </div>
      <div className="grid gap-px overflow-hidden rounded-xl border border-forest-300 bg-forest-300 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-24 bg-forest-600/35 p-5">
            <div className="h-2.5 w-20 rounded bg-forest-300/40" />
            <div className="mt-3 h-6 w-24 rounded bg-forest-300/55" />
          </div>
        ))}
      </div>
    </>
  );
}

function TableBody() {
  return (
    <>
      <div className="flex gap-3">
        <div className="h-9 flex-1 rounded-lg border border-forest-300 bg-forest-600/35" />
        <div className="h-9 w-28 rounded-lg border border-forest-300 bg-forest-600/35" />
      </div>
      <div className="overflow-hidden rounded-xl border border-forest-300 bg-forest-600/30">
        <div className="h-10 border-b border-forest-300 bg-base-deep/30" />
        <div className="px-4">
          {ROWS.map((_, index) => (
            <div
              key={index}
              className="grid grid-cols-[minmax(10rem,1fr)_7rem_6rem] gap-5 border-b border-forest-300/40 py-4 last:border-0"
            >
              <div className="h-3 rounded bg-forest-300/45" />
              <div className="h-3 rounded bg-forest-300/35" />
              <div className="h-3 rounded bg-forest-300/30" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function DetailBody() {
  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="h-[30rem] rounded-2xl border border-forest-300 bg-forest-600/35" />
      <div className="space-y-px overflow-hidden rounded-xl border border-forest-300 bg-forest-300">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-24 bg-forest-600/40 p-4">
            <div className="h-2.5 w-20 rounded bg-forest-300/45" />
            <div className="mt-3 h-3 w-3/4 rounded bg-forest-300/35" />
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsBody() {
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <div className="space-y-2 rounded-xl border border-forest-300 bg-forest-600/30 p-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="h-9 rounded-lg bg-forest-300/35" />
        ))}
      </div>
      <div className="rounded-2xl border border-forest-300 bg-forest-600/30 p-6">
        <div className="h-5 w-44 rounded bg-forest-300/55" />
        <div className="mt-3 h-3 w-3/4 rounded bg-forest-300/30" />
        <div className="mt-8 space-y-5">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index}>
              <div className="h-2.5 w-24 rounded bg-forest-300/40" />
              <div className="mt-2 h-10 rounded-lg border border-forest-300 bg-base-deep/30" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TeaserBody() {
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="h-72 rounded-2xl border border-forest-300 bg-forest-600/35 p-7">
        <div className="h-10 w-10 rounded-xl bg-forest-300/45" />
        <div className="mt-8 h-5 w-48 rounded bg-forest-300/55" />
        <div className="mt-4 h-3 w-4/5 rounded bg-forest-300/30" />
        <div className="mt-2 h-3 w-3/5 rounded bg-forest-300/30" />
      </div>
      <div className="h-52 rounded-xl border border-forest-300 bg-forest-600/30" />
    </div>
  );
}
