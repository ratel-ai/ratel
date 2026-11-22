import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cn } from "@ratel/design-system/cn";
import { cva, type VariantProps } from "class-variance-authority";

/**
 * The app's one button. The upstream shadcn variants referenced design tokens
 * (--color-primary / --color-destructive / --color-ring / --radius-md) that this
 * project never defined, so every button rendered as unstyled text. These variants
 * are wired straight to the Ratel brand palette instead. Coral is reserved for
 * accents and data (it read as "safety orange" on a solid fill), so the primary
 * action is a clean cream button — the same fill as the segmented control's active
 * pill — over quiet forest neutrals, with coral kept for the reclaim/danger tone
 * and the keyboard focus ring.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:ring-2 focus-visible:ring-coral/60 focus-visible:ring-offset-1 focus-visible:ring-offset-base active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-cream text-base-deep shadow-sm hover:bg-cream-dim",
        outline:
          "border-forest-300 bg-transparent text-cream-dim hover:bg-forest/40 hover:text-cream",
        secondary:
          "border-forest-300 bg-forest-600/70 text-cream hover:border-forest-300/80 hover:bg-forest-600",
        ghost: "text-warm-muted hover:bg-forest/40 hover:text-cream",
        destructive:
          "border-coral/30 bg-coral/10 text-coral hover:border-coral/50 hover:bg-coral/20",
        link: "text-coral underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-lg px-2.5 text-[0.8rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-4 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
