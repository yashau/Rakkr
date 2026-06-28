import { defineCollection } from "astro:content";
import { docsSchema } from "@astrojs/starlight/schema";
import { glob } from "astro/loaders";

// The documentation Markdown is the single source of truth in the repo-root
// `docs/` directory (also rendered on GitHub and referenced by the baseline
// verifiers). Starlight reads it directly from there — nothing is duplicated.
//
// Excluded from the published site:
//   - `internal/**`            machine-checked verification baselines (not docs)
//   - `RAKKR_SOURCE_OF_TRUTH.md` the internal status ledger
export const collections = {
  docs: defineCollection({
    loader: glob({
      base: "../../docs",
      pattern: ["**/*.{md,mdx}", "!internal/**", "!RAKKR_SOURCE_OF_TRUTH.md"],
      // Map directory index files to clean routes:
      //   index.md                -> index        (Starlight normalizes -> "/")
      //   observability/README.md -> observability
      //   guides/recording.md     -> guides/recording
      generateId: ({ entry }) => {
        const noExt = entry.replace(/\.(md|mdx)$/i, "");
        // A directory README is that directory's index page.
        const normalized = noExt.replace(/(^|\/)readme$/i, "$1index");
        // Drop a trailing "/index" so the directory is the route; keep the
        // bare root "index" (Starlight maps the "index" slug to "/").
        return normalized.replace(/\/index$/i, "") || "index";
      },
    }),
    schema: docsSchema(),
  }),
};
