"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";
import { NO_PROPERTIES, type PropertyChoices } from "@/lib/views/dashboards/properties";

/**
 * The trace properties of a surface (RTL-396): what the Filter and Group by dropdowns and the RQL
 * field of its forms offer. A page reads them once (`loadFormProperties`) and every form below it
 * reads them here, so no form threads them through its props.
 */

export interface PropertyChoicesState {
  projectId: string;
  choices: PropertyChoices;
}

const PropertyChoicesContext = createContext<PropertyChoicesState | null>(null);

export function PropertyChoicesProvider({
  projectId,
  choices,
  children,
}: {
  projectId: string;
  choices: PropertyChoices;
  children: ReactNode;
}) {
  const state = useMemo(() => ({ projectId, choices }), [projectId, choices]);
  return <PropertyChoicesContext value={state}>{children}</PropertyChoicesContext>;
}

/** The surface's properties; none outside a provider. */
export function usePropertyChoices(): PropertyChoicesState {
  return useContext(PropertyChoicesContext) ?? { projectId: "", choices: NO_PROPERTIES };
}
