import { Skeleton } from "@ratel/design-system/states";
import {
  SkeletonBody,
  SkeletonCode,
  SkeletonField,
  SkeletonHeader,
  SkeletonRoot,
  SkeletonSection,
  SkeletonStats,
  SkeletonTable,
} from "@/components/console/settings/skeleton-parts";

export type SettingsSkeletonVariant = "general" | "api-keys" | "developer" | "danger";

/**
 * A project settings tab while it loads. Inside the settings layout only the
 * tab's body shows (the header stays); `withHeader` draws the header and tabs
 * too, for routes outside the layout. Hidden unless the console runs v2.
 */
export function SettingsSkeleton({
  variant,
  withHeader = false,
}: {
  variant: SettingsSkeletonVariant;
  withHeader?: boolean;
}) {
  return (
    <SkeletonRoot label="Loading settings…" page={withHeader}>
      {withHeader ? <SkeletonHeader tabs={4} /> : null}
      <SkeletonBody wide={variant === "developer"}>
        <SettingsSkeletonBody variant={variant} />
      </SkeletonBody>
    </SkeletonRoot>
  );
}

function SettingsSkeletonBody({ variant }: { variant: SettingsSkeletonVariant }) {
  switch (variant) {
    case "general":
      return (
        <SkeletonSection>
          <SkeletonField />
          <Skeleton className="h-8 w-24" />
        </SkeletonSection>
      );
    case "api-keys":
      return (
        <>
          <SkeletonSection action>
            <SkeletonTable rows={3} columns={6} />
          </SkeletonSection>
          <SkeletonSection>
            <SkeletonCode lines={2} />
            <SkeletonCode lines={8} />
          </SkeletonSection>
        </>
      );
    case "developer":
      return (
        <>
          <SkeletonSection action>
            <SkeletonStats count={3} />
          </SkeletonSection>
          <SkeletonSection action>
            <div className="flex gap-2">
              <Skeleton className="h-8 w-40" />
              <Skeleton className="h-8 w-40" />
            </div>
            <SkeletonTable rows={8} columns={5} />
          </SkeletonSection>
        </>
      );
    case "danger":
      return (
        <SkeletonSection>
          <Skeleton className="h-16 w-full max-w-3xl rounded-lg" />
        </SkeletonSection>
      );
  }
}
