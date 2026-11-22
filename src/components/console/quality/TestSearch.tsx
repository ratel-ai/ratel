"use client";

import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { Tooltip } from "@ratel/design-system/tooltip";
import { FlaskConical } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { playgroundHref } from "@/lib/synthesis/playground/links";
import type { SearchTest } from "@/lib/views/quality/test-search";

const LABEL = "Test this search";

/**
 * "Test this search": the Playground with the search prefilled. A search an
 * experiment recorded travels by its ids (the Playground reads its ask and both
 * rankings back); a plain recorded search has no such id, so its ask is put in
 * the address only when someone clicks. People's words never sit in an
 * attribute (PRIVACY, DESIGN.md). `icon` is the compact form for a list.
 */
export function TestSearch({
  projectId,
  test,
  variant = "secondary",
  className,
}: {
  projectId: string;
  test: SearchTest | null;
  variant?: "secondary" | "ghost" | "icon";
  className?: string;
}) {
  const router = useRouter();
  if (!test) return null;
  const icon = variant === "icon";
  const classes = cn(
    buttonVariants({ variant: icon ? "ghost" : variant, size: icon ? "icon-sm" : "sm" }),
    className,
  );
  const body = icon ? (
    <FlaskConical aria-hidden className="size-3.5" />
  ) : (
    <>
      <FlaskConical aria-hidden className="size-3.5" />
      {LABEL}
    </>
  );
  const control =
    test.kind === "selection" ? (
      <Link
        href={playgroundHref(projectId, {
          selectionId: test.selectionId,
          experimentName: test.experimentName,
        })}
        aria-label={icon ? LABEL : undefined}
        className={classes}
      >
        {body}
      </Link>
    ) : (
      <button
        type="button"
        aria-label={icon ? LABEL : undefined}
        className={classes}
        onClick={() => router.push(playgroundHref(projectId, { query: test.query }))}
      >
        {body}
      </button>
    );
  return icon ? <Tooltip content={LABEL}>{control}</Tooltip> : control;
}
