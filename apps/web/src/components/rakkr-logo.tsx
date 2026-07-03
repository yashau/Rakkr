import { cn } from "@/lib/utils";

/**
 * Rakkr brand mark: a navy tile with a white "r" and a red recording dot.
 * Mirrors the favicon (apps/web/public/favicon.svg) and the docs-site logo, so
 * the colours are the fixed brand palette rather than theme tokens — the navy
 * tile carries its own contrast on both light and dark backgrounds. Size it
 * with a `size-*` utility via `className`; the SVG scales to fit.
 *
 * Decorative: every placement sits beside the visible "Rakkr" wordmark or a
 * labelled region, so the mark is `aria-hidden` to avoid a redundant
 * announcement.
 */
export function RakkrLogo({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={cn("size-10", className)}
      fill="none"
      focusable="false"
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect fill="#0d2b4e" height="32" rx="7" width="32" />
      <text
        fill="#ffffff"
        fontFamily="Arial, Helvetica, sans-serif"
        fontSize="27"
        fontWeight="700"
        x="8.5"
        y="25"
      >
        r
      </text>
      <circle cx="24" cy="8" fill="#e5484d" r="3.4" />
    </svg>
  );
}
