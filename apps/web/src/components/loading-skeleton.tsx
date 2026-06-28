import { Skeleton } from "@/components/ui/skeleton";

/** A layout-stable placeholder for page/section loading states. */
export function LoadingSkeleton({
  label = "Loading",
  rows = 2,
}: {
  label?: string;
  rows?: number;
}) {
  return (
    <output aria-label={label} className="grid gap-3">
      <Skeleton className="h-8 w-48" />
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton className="h-28 w-full" key={index} />
      ))}
    </output>
  );
}
