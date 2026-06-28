import js from "@eslint/js";
import eslintPluginAstro from "eslint-plugin-astro";

export default [
  // The Cloudflare Worker is TypeScript with Workers globals; it is typechecked
  // via worker/tsconfig.json and bundled by wrangler, not by this Astro lint.
  { ignores: ["dist/**", ".astro/**", "worker/**"] },
  js.configs.recommended,
  ...eslintPluginAstro.configs["flat/recommended"],
];
