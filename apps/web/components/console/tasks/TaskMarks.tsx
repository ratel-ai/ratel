import { cn } from "@ratel/design-system/cn";
import { TASK_COLOR_CLASSES, type TaskColorSlot } from "@ratel/design-system/task-colors";
import { CircleCheck, CircleX, Eye, type LucideIcon, Timer } from "lucide-react";
import { TASK_STATUS_LABEL, type TaskStatus } from "@/lib/views/tasks/status";

/**
 * The marks a task wears everywhere: its color (the three busiest tasks
 * keep one hue each, `lib/tasks/palette.ts`) and its status as an icon plus
 * a word, never color alone (DESIGN.md, Color). The color mark is the one
 * `TaskPin` carries (`components/ds/entity.tsx`): a small square, so a task
 * reads the same in a pin, on a row and beside a title.
 */

/** The task's color as TaskPin draws it: a 2 px rounded square. */
export function TaskDot({ color, className }: { color: TaskColorSlot | null; className?: string }) {
  return (
    <span
      aria-hidden
      data-task-color={color ?? "neutral"}
      className={cn(
        "inline-block size-2 shrink-0 rounded-[2px]",
        TASK_COLOR_CLASSES[color ?? "neutral"].bg,
        className,
      )}
    />
  );
}

/** The task's color as an accent bar beside its page title. */
export function TaskColorBar({
  color,
  className,
}: {
  color: TaskColorSlot | null;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-task-color={color ?? "neutral"}
      className={cn(
        "inline-block h-5 w-1 shrink-0 rounded-full",
        TASK_COLOR_CLASSES[color ?? "neutral"].bg,
        className,
      )}
    />
  );
}

const STATUS_ICON: Readonly<Record<TaskStatus, { icon: LucideIcon; tone: string }>> = {
  failing: { icon: CircleX, tone: "text-danger" },
  slow: { icon: Timer, tone: "text-warning" },
  watch: { icon: Eye, tone: "text-warning" },
  healthy: { icon: CircleCheck, tone: "text-success" },
};

/** The status icon alone, for a mark beside the number that explains it; the word is said elsewhere. */
export function TaskStatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  const { icon: Icon, tone } = STATUS_ICON[status];
  return (
    <Icon aria-hidden strokeWidth={1.5} className={cn("size-3.5 shrink-0", tone, className)} />
  );
}

export function TaskStatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  return (
    <span
      data-task-status={status}
      className={cn(
        "inline-flex items-center gap-1.5 text-ui whitespace-nowrap text-fg-muted",
        className,
      )}
    >
      <TaskStatusIcon status={status} />
      {TASK_STATUS_LABEL[status]}
    </span>
  );
}
