import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// A single line of cell text that truncates with an ellipsis and, only when the
// text is actually clipped, reveals the full value in a tooltip on hover/focus.
// The width cap comes from `className` (e.g. a `max-w-*` utility) or an ancestor;
// without a width constraint nothing truncates. Used by DataTable for every text
// cell, and directly inside multi-line cells (name + id) so each line clamps on
// its own.
export function TruncateCell({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Holds the full text when clipped, or null when it fits (no tooltip needed).
  const [overflowText, setOverflowText] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;

    if (!el) {
      return;
    }

    const measure = () => {
      const clipped = el.scrollWidth > el.clientWidth + 1;
      const next = clipped ? (el.textContent ?? "") : null;

      setOverflowText((prev) => (prev === next ? prev : next));
    };

    measure();

    const observer = new ResizeObserver(measure);

    observer.observe(el);

    return () => observer.disconnect();
    // Re-measure (and re-subscribe) when the cell content changes; width changes
    // are handled by the ResizeObserver. Without this dep the observer was torn
    // down and rebuilt on every render (audit W2-OBSERVER-DEP).
  }, [children]);

  const line = (
    <div ref={ref} className={cn("truncate", className)}>
      {children}
    </div>
  );

  if (overflowText === null) {
    return line;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={line} />
      <TooltipContent>{overflowText}</TooltipContent>
    </Tooltip>
  );
}
