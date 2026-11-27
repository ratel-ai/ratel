import { buttonVariants } from "@ratel/design-system/button-variants";
import { Compass } from "lucide-react";
import Link from "next/link";

/** The way from a page of traces to the same traces in Explore. */
export function ExploreLink({ href }: { href: string }) {
  return (
    <Link href={href} className={buttonVariants({ variant: "secondary", size: "sm" })}>
      <Compass className="size-3.5" aria-hidden />
      Explore
    </Link>
  );
}
