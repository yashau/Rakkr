import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import remarkFrontmatter from "remark-frontmatter";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import remarkDocLinks, { isExcluded, toSlug } from "../remark-doc-links.mjs";

const docsRoot = path.resolve(import.meta.dirname, "../../../docs");
const distRoot = path.resolve(import.meta.dirname, "../dist");

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkDocLinks)
  .use(remarkStringify, { bullet: "-", fences: true });

for (const sourcePath of await markdownFiles(docsRoot)) {
  const relativePath = toPosix(path.relative(docsRoot, sourcePath));
  if (isExcluded(relativePath)) continue;

  const source = await readFile(sourcePath, "utf8");
  const markdown = String(await processor.process({ path: sourcePath, value: source }));
  const outputPath = path.join(distRoot, toSlug(relativePath), "index.md");

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, markdown, "utf8");
}

async function markdownFiles(directory) {
  const paths = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await markdownFiles(entryPath)));
    } else if (/\.(md|mdx)$/iu.test(entry.name)) {
      paths.push(entryPath);
    }
  }

  return paths;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
