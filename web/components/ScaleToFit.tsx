"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Renders children at a fixed nominal width (a physical panel's logical width)
 * and scales them down uniformly when the available space is narrower.
 * Purely visual: layout decisions come from the panel class, never from pixels.
 */
export function ScaleToFit({ width, children }: { width: number; children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ scale: number; height: number | undefined }>({ scale: 1, height: undefined });

  useLayoutEffect(() => {
    const outerEl = outer.current;
    const innerEl = inner.current;
    if (!outerEl || !innerEl) return;
    // ResizeObserver fires once on observe, which gives the initial measurement.
    const observer = new ResizeObserver(() => {
      const scale = Math.min(1, outerEl.clientWidth / width);
      setFit({ scale, height: innerEl.offsetHeight * scale });
    });
    observer.observe(outerEl);
    observer.observe(innerEl);
    return () => observer.disconnect();
  }, [width]);

  return (
    <div ref={outer} className="relative mx-auto w-full overflow-hidden" style={{ maxWidth: width, height: fit.height }}>
      <div ref={inner} style={{ width, transform: `scale(${fit.scale})`, transformOrigin: "top left" }}>
        {children}
      </div>
    </div>
  );
}
