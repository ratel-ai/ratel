"use client";

import { type ReactNode, useState } from "react";

type HoneybadgerImageProps = {
  src: string;
  alt: string;
  className?: string;
  fallback: ReactNode;
};

export function HoneybadgerImage({ src, alt, className, fallback }: HoneybadgerImageProps) {
  const [failed, setFailed] = useState(false);

  if (failed) return fallback;

  return (
    // The files are optional drop-ins with pose-specific aspect ratios.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} className={className} onError={() => setFailed(true)} />
  );
}
