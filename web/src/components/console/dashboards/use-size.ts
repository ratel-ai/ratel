import { type RefObject, useEffect, useRef, useState } from "react";

/** The size of the place a chart is in, as it changes. Zero until the browser measures. */
export function useSize<E extends HTMLElement>(): [
  RefObject<E | null>,
  { width: number; height: number },
] {
  const ref = useRef<E>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const observer = new ResizeObserver(() =>
      setSize({ width: host.clientWidth, height: host.clientHeight }),
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}
