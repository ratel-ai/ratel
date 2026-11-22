"use client";

import { Import } from "lucide-react";
import { openHealthImport } from "@/components/console/health/imports/open-import";
import { Button } from "@/components/console/health/primitives/button";

/** "Import past runs" on a v1 state block: opens the importer mounted on the page. */
export function OpenImportButton() {
  return (
    <Button variant="outline" size="sm" onClick={openHealthImport} data-health-open-import="true">
      <Import className="size-3.5" aria-hidden />
      Import past runs
    </Button>
  );
}
