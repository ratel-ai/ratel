import { type ComponentProps, type ReactNode, useId } from "react";
import { cn } from "../cn";

const CONTROL =
  "w-full min-w-0 rounded-md border border-line-strong bg-app text-ui text-fg placeholder:text-fg-faint outline-none transition-[border-color,box-shadow] duration-120 hover:border-line-active focus-visible:border-line-active focus-visible:ring-2 focus-visible:ring-focus/40 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger aria-invalid:focus-visible:ring-danger/30";

/** A text input. 32 px tall, 16 px on touch screens so iOS never zooms. */
export function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(CONTROL, "h-8 px-2.5 max-md:text-base", className)}
      {...props}
    />
  );
}

/** ⌘Enter submits when the textarea's form wires it; Enter makes a new line. */
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(CONTROL, "min-h-20 px-2.5 py-2 leading-5 max-md:text-base", className)}
      {...props}
    />
  );
}

export type FieldProps = {
  label: ReactNode;
  /** Help under the control. Replaced by the error when there is one. */
  description?: ReactNode;
  error?: ReactNode;
  /** Renders the control with the ids it needs for its label, help and error. */
  children: (control: {
    id: string;
    "aria-describedby"?: string;
    "aria-invalid"?: true;
  }) => ReactNode;
  className?: string;
};

/** Label above, control, then help or the error below (DESIGN.md, Forms). */
export function Field({ label, description, error, children, className }: FieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? description;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-xs font-medium text-fg-muted">
        {label}
      </label>
      {children({
        id,
        ...(note ? { "aria-describedby": noteId } : {}),
        ...(error ? { "aria-invalid": true as const } : {}),
      })}
      {note ? (
        <p id={noteId} className={cn("text-xs", error ? "text-danger" : "text-fg-subtle")}>
          {note}
        </p>
      ) : null}
    </div>
  );
}
