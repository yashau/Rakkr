import path from "node:path";

// The docs Markdown uses repo-relative `.md` links so it also renders correctly
// on GitHub. Astro does not rewrite those links when content is loaded from an
// external directory, so this remark plugin rewrites them at build time:
//   - links to published pages      -> Starlight page URLs (e.g. /guides/recording/)
//   - links to excluded/external md -> GitHub blob URLs (so they still resolve)
//
// Keep the exclusion + slug logic in sync with src/content.config.ts.

const DOCS_ROOT = path.resolve(import.meta.dirname, "../../docs");
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const GITHUB_BASE = "https://github.com/yashau/Rakkr";

function isExcluded(relFromDocs) {
  return relFromDocs === "RAKKR_SOURCE_OF_TRUTH.md" || relFromDocs.startsWith("internal/");
}

function toSlug(relFromDocs) {
  const noExt = relFromDocs.replace(/\.(md|mdx)$/i, "");
  const normalized = noExt.replace(/(^|\/)readme$/i, "$1index");
  const trimmed = normalized.replace(/\/index$/i, "");
  return trimmed === "index" ? "" : trimmed;
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function visitLinks(node, fn) {
  if (!node || typeof node !== "object") return;
  if (node.type === "link") fn(node);
  if (Array.isArray(node.children)) for (const child of node.children) visitLinks(child, fn);
}

export default function remarkDocLinks() {
  return (tree, file) => {
    const fileAbs = file.path ?? file.history?.[0];
    if (!fileAbs) return;
    const fileDir = path.dirname(fileAbs);

    visitLinks(tree, (node) => {
      const url = node.url;
      if (!url || /^(https?:|mailto:|tel:|#|\/)/i.test(url)) return;

      const hashIndex = url.indexOf("#");
      const rawPath = hashIndex === -1 ? url : url.slice(0, hashIndex);
      const anchor = hashIndex === -1 ? "" : url.slice(hashIndex);
      if (rawPath === "") return;

      const targetAbs = path.resolve(fileDir, rawPath);
      const relFromDocs = toPosix(path.relative(DOCS_ROOT, targetAbs));
      const isMarkdown = /\.(md|mdx)$/i.test(rawPath);

      if (isMarkdown && !relFromDocs.startsWith("..") && !isExcluded(relFromDocs)) {
        // A published documentation page -> its Starlight URL.
        const slug = toSlug(relFromDocs);
        node.url = (slug ? `/${slug}/` : "/") + anchor;
      } else {
        // Anything else (repo files, excluded internals, directories) -> GitHub.
        const relFromRepo = toPosix(path.relative(REPO_ROOT, targetAbs));
        const kind = rawPath.endsWith("/") ? "tree" : "blob";
        node.url = `${GITHUB_BASE}/${kind}/main/${relFromRepo}${anchor}`;
      }
    });
  };
}
