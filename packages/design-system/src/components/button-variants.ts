import { cva } from "class-variance-authority";

/**
 * The one button (DESIGN.md, Components). `primary` is coral and appears once
 * per view, for the action the view exists for; `secondary` is the default;
 * `ghost` is for toolbars and rows; `danger` is only for the confirming button
 * of a destructive dialog.
 */
export const buttonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap select-none",
    "transition-[background-color,border-color,color] duration-120 ease-enter",
    "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app",
    "disabled:pointer-events-none disabled:opacity-50 data-disabled:pointer-events-none data-disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        primary: "border-transparent bg-accent text-accent-fg hover:bg-accent-hover",
        secondary: "border-line-strong bg-raised text-fg hover:border-line-active hover:bg-hover",
        ghost: "border-transparent bg-transparent text-fg-muted hover:bg-hover hover:text-fg",
        danger: "border-transparent bg-danger-fill text-accent-fg hover:bg-danger-fill/90",
      },
      size: {
        sm: "h-7 px-2.5 text-ui",
        md: "h-8 px-3 text-ui",
        "icon-sm": "size-7 text-ui",
        icon: "size-8 text-ui",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);
