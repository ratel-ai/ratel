"use client";

import { Skeleton } from "@ratel/design-system/states";
import { type ComponentProps, useEffect, useState } from "react";
import type { MetricQuery } from "@/lib/contracts/query";
import { alertQueryOf } from "@/lib/views/alerts/links";
import { parseAlertQuery } from "@/lib/views/alerts/parse-rule";
import { AlertForm } from "./AlertForm";

/** The form of a new alert, with the query of the link, which may be in the fragment. */
export function NewAlertForm({
  start,
  inFragment,
  pageFilters,
  ...form
}: Omit<ComponentProps<typeof AlertForm>, "rule"> & {
  /** Only the browser knows the query. */
  inFragment: boolean;
  /** The query has the filters of the Explore page. */
  pageFilters: boolean;
}) {
  const [read, setRead] = useState<{ query: MetricQuery | null } | null>(
    inFragment ? null : { query: start },
  );
  useEffect(() => {
    if (!inFragment) return;
    const parsed = parseAlertQuery(alertQueryOf(window.location.hash.slice(1)));
    setRead({ query: parsed.ok ? parsed.query : null });
  }, [inFragment]);
  if (!read) return <Skeleton className="h-96 w-full" />;
  return (
    <>
      {inFragment && !read.query ? (
        <p role="alert" className="text-sm text-danger">
          The link lost its query on the way here. Open the link again.
        </p>
      ) : null}
      {read.query && pageFilters ? (
        <p role="status" className="text-sm text-fg-muted">
          The filters of the Explore page are included in the filter below.
        </p>
      ) : null}
      <AlertForm rule={null} start={read.query} {...form} />
    </>
  );
}
