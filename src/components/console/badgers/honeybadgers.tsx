/**
 * Drop-in mascot art contract — no code changes are required when art arrives.
 *
 * Files (exact): public/badgers/searching.png, tangled.png, sleeping.png,
 * construction.png, celebration.png, and waving.png.
 * Size (exact): 1024px tall with proportional pose-specific width.
 * Style: transparent PNG; engraved honey-badger illustration with a cream
 * rim-light, composed for the product's dark backgrounds.
 */

import { BadgerMark } from "@ratel/design-system/badger-mark";
import type { ComponentPropsWithoutRef } from "react";
import {
  getBadgerAssetSource,
  type HoneybadgerPose,
} from "@/components/console/badgers/honeybadger-assets";
import { HoneybadgerImage } from "@/components/console/badgers/honeybadger-image";

export type HoneybadgerProps = Pick<ComponentPropsWithoutRef<"img">, "className" | "alt">;

export function SearchingBadger(props: HoneybadgerProps) {
  return renderBadger("searching", "Searching honey badger", props);
}

export function TangledBadger(props: HoneybadgerProps) {
  return renderBadger("tangled", "Tangled honey badger", props);
}

export function SleepingBadger(props: HoneybadgerProps) {
  return renderBadger("sleeping", "Sleeping honey badger", props);
}

export function ConstructionBadger(props: HoneybadgerProps) {
  return renderBadger("construction", "Honey badger under construction", props);
}

export function CelebrationBadger(props: HoneybadgerProps) {
  return renderBadger("celebration", "Celebrating honey badger", props);
}

export function WavingBadger(props: HoneybadgerProps) {
  return renderBadger("waving", "Waving honey badger", props);
}

function renderBadger(pose: HoneybadgerPose, defaultAlt: string, props: HoneybadgerProps) {
  const fallback = <BadgerFallback defaultAlt={defaultAlt} {...props} />;
  const src = getBadgerAssetSource(pose);

  if (!src) return fallback;

  return (
    <HoneybadgerImage
      src={src}
      alt={props.alt ?? defaultAlt}
      className={props.className}
      fallback={fallback}
    />
  );
}

function BadgerFallback({ className, alt, defaultAlt }: HoneybadgerProps & { defaultAlt: string }) {
  return (
    <BadgerMark
      className={className}
      role="img"
      aria-label={alt ?? defaultAlt}
      aria-hidden={undefined}
    />
  );
}
