"use client";

import { Button } from "@ratel/design-system/button";
import { Menu, MenuContent, MenuGroup, MenuItem, MenuTrigger } from "@ratel/design-system/menu";
import { toast } from "@ratel/design-system/toast";
import { Check, ChevronDown, Link2, Lock, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { projectRoot } from "@/lib/console/navigation";
import { shareDashboardAction } from "@/lib/views/custom-dashboards/actions";
import type { DashboardSharing as Sharing } from "@/lib/views/custom-dashboards/model";

/**
 * The sharing controls of one dashboard (RC-889): who sees it, private or the
 * project, and a link to it. Only the creator changes who sees it; every
 * member who opens it copies the link. The link asks for sign-in and project
 * membership, and a private dashboard opens for its creator only.
 */

export interface DashboardSharingProps {
  projectId: string;
  dashboardId: string;
  sharing: Sharing;
  canShare: boolean;
}

const OPTIONS: ReadonlyArray<{ value: Sharing; label: string; description: string }> = [
  { value: "private", label: "Private", description: "Only you" },
  { value: "project", label: "Project", description: "Every project member" },
];

export function DashboardSharing({
  projectId,
  dashboardId,
  sharing,
  canShare,
}: DashboardSharingProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const current = OPTIONS.find((option) => option.value === sharing) ?? OPTIONS[0];
  const Icon = sharing === "project" ? Users : Lock;

  function share(next: Sharing) {
    if (next === sharing) return;
    startTransition(async () => {
      const result = await shareDashboardAction(projectId, dashboardId, next);
      if (!result.ok) {
        toast({
          title: "Couldn't change who sees the dashboard",
          description: result.error,
          tone: "danger",
        });
        return;
      }
      toast({
        title: next === "project" ? "Shared with the project" : "Dashboard is private",
        tone: "success",
      });
      router.refresh();
    });
  }

  function copyLink() {
    const url = `${window.location.origin}${projectRoot(projectId)}/dashboards/${encodeURIComponent(dashboardId)}`;
    navigator.clipboard.writeText(url).then(
      () =>
        toast({
          title: "Link copied",
          description:
            sharing === "project"
              ? "Project members can open it."
              : "Only you can open it while it is private.",
          tone: "success",
        }),
      () => toast({ title: "Couldn't copy the link", tone: "danger" }),
    );
  }

  return (
    <>
      {canShare ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="secondary"
                loading={pending}
                aria-label={`Who sees this dashboard: ${current.label}`}
              >
                <Icon aria-hidden className="size-4" />
                {current.label}
                <ChevronDown aria-hidden className="size-4" />
              </Button>
            }
          />
          <MenuContent align="end">
            <MenuGroup label="Who sees this dashboard">
              {OPTIONS.map((option) => (
                <MenuItem
                  key={option.value}
                  icon={
                    <Check
                      aria-hidden
                      className={option.value === sharing ? undefined : "invisible"}
                    />
                  }
                  onClick={() => share(option.value)}
                >
                  {option.label}: {option.description.toLowerCase()}
                </MenuItem>
              ))}
            </MenuGroup>
          </MenuContent>
        </Menu>
      ) : null}
      <Button variant="secondary" onClick={copyLink}>
        <Link2 aria-hidden className="size-4" />
        Copy link
      </Button>
    </>
  );
}
