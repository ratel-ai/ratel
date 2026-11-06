"use client";

import { Button } from "@ratel/design-system/button";
import { Import } from "lucide-react";
import { openHealthImport } from "@/components/console/health/imports/open-import";

/** "Import past runs" on a design-system state block: opens the importer mounted on the page. */
export function OpenImportButtonV2({
  variant = "secondary",
}: {
  variant?: "primary" | "secondary";
}) {
  return (
    <Button variant={variant} onClick={openHealthImport} data-health-open-import="true">
      <Import strokeWidth={1.5} aria-hidden />
      Import past runs
    </Button>
  );
}
