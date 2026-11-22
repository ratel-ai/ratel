import { Skeleton } from "@ratel/design-system/states";
import {
  SkeletonBody,
  SkeletonCode,
  SkeletonField,
  SkeletonHeader,
  SkeletonRoot,
  SkeletonSection,
  SkeletonTable,
} from "@/components/console/settings/skeleton-parts";

export type OrgSkeletonVariant =
  | "projects"
  | "members"
  | "billing"
  | "integrations"
  | "settings"
  | "danger";

/**
 * An organization page while it loads: the same header, sections and rows
 * the page draws, so nothing moves when it lands. `body` draws only the
 * page body, for tabs under the settings layout's header.
 */
export function OrgSkeleton({
  variant,
  body = false,
}: {
  variant: OrgSkeletonVariant;
  body?: boolean;
}) {
  return (
    <SkeletonRoot label="Loading…" page={!body}>
      {body ? null : (
        <SkeletonHeader
          action={variant === "projects" || variant === "members"}
          description={variant === "billing" || variant === "integrations"}
        />
      )}
      <SkeletonBody>
        <OrgSkeletonBody variant={variant} />
      </SkeletonBody>
    </SkeletonRoot>
  );
}

function OrgSkeletonBody({ variant }: { variant: OrgSkeletonVariant }) {
  switch (variant) {
    case "projects":
      return (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="ml-auto h-3 w-24" />
          </div>
          <SkeletonTable rows={4} columns={3} />
        </div>
      );
    case "members":
      return (
        <>
          <SkeletonSection>
            <SkeletonTable rows={4} columns={3} />
          </SkeletonSection>
          <SkeletonSection>
            <SkeletonTable rows={2} columns={3} />
          </SkeletonSection>
        </>
      );
    case "billing":
      return (
        <>
          <SkeletonSection action>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-80 rounded-lg" />
              ))}
            </div>
          </SkeletonSection>
          <SkeletonSection>
            <div className="grid gap-4 xl:grid-cols-2">
              <Skeleton className="h-72 rounded-lg" />
              <Skeleton className="h-72 rounded-lg" />
            </div>
          </SkeletonSection>
        </>
      );
    case "integrations":
      return (
        <>
          <SkeletonSection>
            <Skeleton className="h-8 w-96 max-w-full" />
            <SkeletonCode lines={4} />
          </SkeletonSection>
          <SkeletonSection>
            <Skeleton className="h-48 w-full rounded-lg" />
          </SkeletonSection>
        </>
      );
    case "settings":
      return (
        <SkeletonSection>
          <SkeletonField />
          <SkeletonField />
          <Skeleton className="h-8 w-24" />
        </SkeletonSection>
      );
    case "danger":
      return (
        <SkeletonSection>
          <Skeleton className="h-16 w-full max-w-3xl rounded-lg" />
        </SkeletonSection>
      );
  }
}
