import { SettingsSkeleton } from "@/components/console/settings/SettingsSkeleton";

/** This route only redirects to Settings > Developer, so its loading state is that page's, header included. */
export default function RuntimeEventsLoading() {
  return <SettingsSkeleton variant="developer" withHeader />;
}
