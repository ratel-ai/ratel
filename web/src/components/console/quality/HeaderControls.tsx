"use client";

import { Button } from "@ratel/design-system/button";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@ratel/design-system/menu";
import { toast } from "@ratel/design-system/toast";
import { CalendarRange, Check, ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { runMatchQualityAction } from "@/app/(console)/project/[projectId]/improvement/match-quality/actions";
import type { RunMenuModel } from "@/lib/views/quality/run-menu";

/** Slow enough to be cheap, fast enough that a short run does not look stuck (the v1 page's rate). */
const POLL_MS = 2_500;

export interface WindowOption {
  id: string;
  label: string;
  href: string;
  active: boolean;
}

/** The time window as a menu of presets; each is a URL, so refresh and share keep it. */
export function WindowMenu({
  label,
  options,
}: {
  label: string;
  options: readonly WindowOption[];
}) {
  const router = useRouter();
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="secondary" size="md" aria-label={`Time window: ${label}`} />}
      >
        <CalendarRange className="size-3.5 text-fg-subtle" aria-hidden />
        <span className="tabular-nums">{label}</span>
        <ChevronDown className="size-3.5 text-fg-subtle" aria-hidden />
      </MenuTrigger>
      <MenuContent align="end" className="min-w-48">
        {options.map((option) => (
          <MenuItem
            key={option.id}
            icon={option.active ? <Check /> : <span aria-hidden className="size-4" />}
            onClick={() => router.push(option.href, { scroll: false })}
          >
            {option.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

/**
 * Starting a Match quality run, from the header rather than the page body: the
 * analysis runs itself weekly, so this is the rare "read a different window
 * now". Calls the existing run action; while a run is live the trigger keeps
 * its label with a spinner and the page refreshes until it lands.
 */
export function RunMenu({
  projectId,
  model,
  variant = "secondary",
  poll = true,
}: {
  projectId: string;
  model: RunMenuModel;
  /** Primary only where it is the one action of an empty state. */
  variant?: "primary" | "secondary";
  /** One menu per page refreshes it while a run is live; a second copy stays quiet. */
  poll?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!model.live || !poll) return;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [model.live, poll, router]);

  const start = (days: number) => {
    startTransition(async () => {
      const result = await runMatchQualityAction(projectId, days);
      if (!result.ok) {
        toast({
          title: "Couldn't start the analysis",
          description: result.message,
          tone: "danger",
        });
        return;
      }
      toast({
        title: result.message ?? "Analysis started",
        description: result.message ? undefined : "Suggestions update here when it finishes.",
      });
      router.refresh();
    });
  };

  if (model.live || pending) {
    return (
      <>
        <Button variant={variant} size="md" loading>
          Analysing…
        </Button>
        <span role="status" className="sr-only">
          Analysing your searches
        </span>
      </>
    );
  }

  return (
    <Menu>
      <MenuTrigger render={<Button variant={variant} size="md" />}>
        {model.label}
        <ChevronDown className="size-3.5" aria-hidden />
      </MenuTrigger>
      <MenuContent align="end" className="min-w-64">
        <MenuGroup label={model.status}>
          {model.windows.map((window) => (
            <MenuItem
              key={window.days}
              disabled={window.disabled}
              onClick={() => start(window.days)}
            >
              <span className="flex items-center justify-between gap-4">
                <span>{window.label}</span>
                {window.detail ? (
                  <span className="text-xs text-fg-subtle tabular-nums">{window.detail}</span>
                ) : null}
              </span>
            </MenuItem>
          ))}
        </MenuGroup>
        <MenuSeparator />
        <div className="flex flex-col gap-0.5 px-2 pt-1 pb-1.5 text-xs text-fg-subtle">
          <span>{model.budget}</span>
          {model.nextRun ? <span>{model.nextRun}</span> : null}
        </div>
      </MenuContent>
    </Menu>
  );
}
