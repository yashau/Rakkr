import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

const dist = new URL("../dist/", import.meta.url);
const readDistFile = (path) => readFile(new URL(path, dist), "utf8");

const [robots, llms, llmsFull, llmsSmall, sitemapIndex, sitemap, pageMarkdown] = await Promise.all([
  readDistFile("robots.txt"),
  readDistFile("llms.txt"),
  readDistFile("llms-full.txt"),
  readDistFile("llms-small.txt"),
  readDistFile("sitemap-index.xml"),
  readDistFile("sitemap-0.xml"),
  readDistFile("architecture/overview/index.md"),
]);

assert.match(robots, /^User-agent: \*$/mu);
assert.match(robots, /^Allow: \/$/mu);
assert.match(robots, /^Sitemap: https:\/\/docs\.rakkr\.org\/sitemap-index\.xml$/mu);
assert.match(robots, /https:\/\/docs\.rakkr\.org\/llms\.txt/u);

assert.match(llms, /^# Rakkr$/mu);
assert.match(llms, /https:\/\/docs\.rakkr\.org\/llms-small\.txt/u);
assert.match(llms, /https:\/\/docs\.rakkr\.org\/llms-full\.txt/u);
assert.match(llmsFull, /^# Rakkr Documentation$/mu);
assert.match(llmsSmall, /^# Rakkr Documentation$/mu);

assert.match(sitemapIndex, /https:\/\/docs\.rakkr\.org\/sitemap-0\.xml/u);
assert.match(sitemap, /<loc>https:\/\/docs\.rakkr\.org\/<\/loc>/u);
assert.match(sitemap, /<loc>https:\/\/docs\.rakkr\.org\/getting-started\/introduction\/<\/loc>/u);
assert.doesNotMatch(sitemap, /\/internal\//u);
assert.doesNotMatch(sitemap, /RAKKR_SOURCE_OF_TRUTH/u);

assert.match(pageMarkdown, /^title: Architecture overview$/mu);
assert.match(pageMarkdown, /\[Controller API\]\(\/architecture\/controller-api\/\)/u);
assert.doesNotMatch(pageMarkdown, /\]\(controller-api\.md\)/u);

const sitemapPageCount = [...sitemap.matchAll(/<loc>/gu)].length;
const markdownPaths = await findNamedFiles(fileURLToPath(dist), "index.md");
assert.equal(markdownPaths.length, sitemapPageCount);
assert.equal(
  markdownPaths.some((file) => file.includes(`${path.sep}internal${path.sep}`)),
  false,
);

async function findNamedFiles(directory, fileName) {
  const paths = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await findNamedFiles(entryPath, fileName)));
    } else if (entry.name === fileName) {
      paths.push(entryPath);
    }
  }

  return paths;
}
