"use client";

import { IconButton } from "@ratel/design-system/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@ratel/design-system/menu";
import { Archive, MoreHorizontal, Pencil, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type SkillItem,
  type SkillTransition,
  skillTransitions,
} from "@/lib/console/catalog/items";

/**
 * Publish, archive and edit for a Cloud skill, in one menu that rows, the
 * Panel and the tree's detail share. Both status changes happen at once and
 * say so in a toast (with Undo where the way back is exact); neither needs a
 * confirmation, since a published skill can be archived and an archived one
 * published again.
 */
export function SkillActions({
  item,
  onTransition,
  onEdit,
  editHref,
}: {
  item: SkillItem;
  onTransition: (item: SkillItem, transition: SkillTransition) => void;
  /** Open the editor in place (the skills Panel). */
  onEdit?: (item: SkillItem) => void;
  /** Or go to where the editor lives (from the tree). */
  editHref?: string;
}) {
  const router = useRouter();
  if (!item.record) return null;
  const transitions = skillTransitions(item.status);
  return (
    <Menu>
      <MenuTrigger
        render={
          <IconButton label={`Actions for ${item.name}`} icon={<MoreHorizontal />} size="icon-sm" />
        }
      />
      <MenuContent align="end">
        {transitions.includes("publish") ? (
          <MenuItem
            icon={<Upload strokeWidth={1.5} />}
            onClick={() => onTransition(item, "publish")}
          >
            Publish skill
          </MenuItem>
        ) : null}
        {transitions.includes("archive") ? (
          <MenuItem
            icon={<Archive strokeWidth={1.5} />}
            onClick={() => onTransition(item, "archive")}
          >
            Archive skill
          </MenuItem>
        ) : null}
        {onEdit || editHref ? (
          <>
            <MenuSeparator />
            <MenuItem
              icon={<Pencil strokeWidth={1.5} />}
              onClick={() => (onEdit ? onEdit(item) : editHref ? router.push(editHref) : undefined)}
            >
              Edit skill…
            </MenuItem>
          </>
        ) : null}
      </MenuContent>
    </Menu>
  );
}
