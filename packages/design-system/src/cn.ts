import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge has to know the design system's custom scale: without it,
 * `text-ui` (13/18) reads as a text color and is dropped whenever a real color
 * like `text-fg-muted` follows it in the same class list.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["ui"] }],
      shadow: [{ shadow: ["overlay", "dialog"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
