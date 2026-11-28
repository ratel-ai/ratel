"use client";

import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Select } from "@ratel/design-system/select";
import { CircleAlert } from "lucide-react";
import Link from "next/link";
import { useId, useRef, useState } from "react";
import type { TemplateCard } from "@/lib/views/dashboards/templates/types";

/** The settings section where a trace property is indexed. */
const PROPERTIES_HREF = (projectId: string) =>
  `/project/${encodeURIComponent(projectId)}/settings#trace-properties`;

/**
 * "Start from a template": the ten templates as small cards. A click makes the dashboard of one
 * and opens it; one whose data the project lacks says what is missing and still makes it. By
 * customer first takes an indexed trace property; with none it links to where one is indexed. One
 * click makes one dashboard: a second one while it is made does nothing.
 */
export function TemplateGallery({
  projectId,
  templates,
  properties,
  disabled,
  onCreate,
}: {
  projectId: string;
  templates: readonly TemplateCard[];
  /** The names of the project's indexed trace properties. */
  properties: readonly string[];
  disabled: boolean;
  /** Makes the dashboard and opens it: true when it was made. */
  onCreate: (template: string, property?: string) => Promise<boolean>;
}) {
  const headingId = useId();
  const [asking, setAsking] = useState<string | null>(null);
  const [property, setProperty] = useState(properties[0] ?? "");
  // A state update lands after the click: the ref stops a second click before it does.
  const making = useRef(false);

  function make(template: string, chosen?: string) {
    if (making.current || disabled) return;
    making.current = true;
    // Once made, the dashboard opens: no click makes a second one. After a refusal one may try again.
    void onCreate(template, chosen).then((made) => {
      if (!made) making.current = false;
    });
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-ui font-medium text-fg">
        Start from a template
      </h3>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {templates.map((template) => (
          <li key={template.id}>
            {asking === template.id ? (
              <PropertyCard
                projectId={projectId}
                template={template}
                properties={properties}
                property={property}
                disabled={disabled}
                onProperty={setProperty}
                onCreate={() => make(template.id, property)}
                onCancel={() => setAsking(null)}
              />
            ) : (
              <button
                type="button"
                disabled={disabled}
                aria-describedby={`${template.id}-about`}
                className={cn(
                  "flex h-full w-full flex-col gap-1 rounded-md border border-border p-3 text-left",
                  "hover:border-border-strong hover:bg-bg-subtle disabled:cursor-not-allowed disabled:opacity-60",
                )}
                onClick={() => (template.property ? setAsking(template.id) : make(template.id))}
              >
                <span className="text-ui font-medium text-fg">{template.name}</span>
                <span id={`${template.id}-about`} className="text-xs text-fg-muted">
                  {template.description}
                </span>
                {template.has ? null : <Missing reasons={template.missing} />}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** By customer: the indexed property it groups by, or where to index one. */
function PropertyCard({
  projectId,
  template,
  properties,
  property,
  disabled,
  onProperty,
  onCreate,
  onCancel,
}: {
  projectId: string;
  template: TemplateCard;
  properties: readonly string[];
  property: string;
  disabled: boolean;
  onProperty: (name: string) => void;
  onCreate: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-2 rounded-md border border-border-strong p-3">
      <span className="text-ui font-medium text-fg">{template.name}</span>
      {properties.length === 0 ? (
        <p className="text-xs text-fg-muted">
          It groups by an indexed trace property, and this project has none.{" "}
          <Link href={PROPERTIES_HREF(projectId)} className="font-medium text-fg underline">
            Index a trace property
          </Link>
        </p>
      ) : (
        <Select
          aria-label="The trace property to group by"
          className="w-full"
          options={properties.map((name) => ({ value: name, label: name }))}
          value={property}
          onValueChange={(name) => onProperty(String(name))}
        />
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Back
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={disabled || properties.length === 0 || !property}
          onClick={onCreate}
        >
          Create
        </Button>
      </div>
    </div>
  );
}

function Missing({ reasons }: { reasons: readonly string[] }) {
  return (
    <span className="mt-1 flex items-center gap-1 text-xs text-fg-subtle">
      <CircleAlert className="size-3 shrink-0" aria-hidden />
      {reasons.join(". ")}
    </span>
  );
}
