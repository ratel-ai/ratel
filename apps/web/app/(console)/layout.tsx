import { BadgerMark } from "@ratel/design-system/badger-mark";
import { TabNav } from "@ratel/design-system/tabs";
import Link from "next/link";
import type { ReactNode } from "react";
import { getRuntime } from "@/lib/runtime";

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const runtime = await getRuntime();
  const tabs = [
    { href: "/", label: "Home", exact: true },
    ...runtime.nav.map((item) => ({ href: item.href, label: item.label })),
  ];

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-12 items-center gap-6 border-b border-line bg-rail px-6 lg:px-8">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-md text-sm font-semibold text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <BadgerMark className="h-3.5 w-auto text-brand-cream" />
          Ratel
        </Link>
        <TabNav label="Main" tabs={tabs} />
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
