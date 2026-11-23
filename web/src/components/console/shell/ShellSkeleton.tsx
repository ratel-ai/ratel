import { Skeleton } from "@ratel/design-system/states";

/**
 * The signed-in shell while the launch gate, the session and the navigation
 * resolve (see app/(app)/layout.tsx): the rail and an empty page, sized like
 * `AppFrame`, so the real shell swaps in without a shift and entering the app
 * never sits on the caller's last frame. The rail is drawn expanded; one the
 * reader collapsed narrows when the shell lands.
 */
export function ShellSkeleton() {
  return (
    <div className="flex min-h-dvh bg-app" aria-hidden>
      <div className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-2 border-r border-line bg-rail px-2 md:flex">
        <div className="flex h-13 shrink-0 items-center px-1">
          <Skeleton className="h-6 w-36" />
        </div>
        <Skeleton className="h-8 w-full" />
        <div className="mt-2 flex flex-col gap-1.5">
          {Array.from({ length: 7 }, (_, index) => (
            <Skeleton key={index} className="h-7 w-full" />
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="h-12 shrink-0 border-b border-line bg-rail md:hidden" />
      </div>
    </div>
  );
}
