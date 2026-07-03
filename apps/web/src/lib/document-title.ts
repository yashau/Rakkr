import { useEffect } from "react";

const TITLE_SUFFIX = "Rakkr";

/**
 * Builds the browser-tab title as `<page> - Rakkr`. A missing or blank page
 * label — e.g. a detail page whose entity name is still loading — collapses to
 * just "Rakkr".
 */
export function documentTitle(pageTitle?: string | null): string {
  const trimmed = pageTitle?.trim();

  return trimmed ? `${trimmed} - ${TITLE_SUFFIX}` : TITLE_SUFFIX;
}

/**
 * Sets `document.title` to `<page> - Rakkr` for the mounted page. Pass the page
 * label or an entity name (recording node, room, schedule, user); pass
 * `undefined` while it loads to fall back to "Rakkr".
 */
export function useDocumentTitle(pageTitle?: string | null): void {
  useEffect(() => {
    document.title = documentTitle(pageTitle);
  }, [pageTitle]);
}
