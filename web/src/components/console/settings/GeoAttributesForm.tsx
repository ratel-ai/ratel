"use client";

import { Button } from "@ratel/design-system/button";
import { Field, Input } from "@ratel/design-system/input";
import { toast } from "@ratel/design-system/toast";
import { useState, useTransition } from "react";
import { saveGeoAttributesAction } from "@/app/(console)/project/[projectId]/settings/geo-actions";
import { GEO_ATTRIBUTES, type GeoAttributes } from "@/lib/ingest/geo/attributes";

const LABELS: Readonly<Record<keyof GeoAttributes, { label: string; description: string }>> = {
  address: {
    label: "IP address",
    description: "Resolved to a country and a region as the trace arrives. Never stored.",
  },
  country: { label: "Country", description: "An ISO 3166-1 code, for example US." },
  region: { label: "Region", description: "An ISO 3166-2 code, for example US-CA." },
  latitude: { label: "Latitude", description: "In degrees." },
  longitude: { label: "Longitude", description: "In degrees." },
};

/** The attributes a trace's location is read from. */
export function GeoAttributesForm({
  projectId,
  initial,
  canChange,
}: {
  projectId: string;
  initial: GeoAttributes;
  canChange: boolean;
}) {
  const [attributes, setAttributes] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="flex max-w-xl flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await saveGeoAttributesAction(projectId, attributes);
          if (result.ok) toast({ title: "Location attributes saved", tone: "success" });
          else setError(result.error);
        });
      }}
    >
      <p className="text-ui text-fg-muted">
        A country wins over coordinates, and coordinates over an IP address. A change applies to the
        traces that arrive from then on.
      </p>
      {GEO_ATTRIBUTES.map((key) => (
        <Field key={key} label={LABELS[key].label} description={LABELS[key].description}>
          {(control) => (
            <Input
              {...control}
              className="font-mono text-xs"
              value={attributes[key]}
              maxLength={200}
              autoComplete="off"
              disabled={!canChange}
              onChange={(event) =>
                setAttributes({ ...attributes, [key]: event.currentTarget.value })
              }
            />
          )}
        </Field>
      ))}
      {error ? (
        <p role="alert" className="text-ui text-danger">
          {error}
        </p>
      ) : null}
      {canChange ? (
        <div>
          <Button type="submit" variant="secondary" loading={pending}>
            Save
          </Button>
        </div>
      ) : (
        <p className="text-ui text-fg-muted">Only organization admins can change them.</p>
      )}
    </form>
  );
}
