import { execFileSync } from "node:child_process";

// Cuts a release by pushing a calendar-versioned git tag. A pushed tag is the
// only thing that triggers a component's release workflow, so this script is the
// single deliberate "ship it" action.
//
// Tag scheme: `<component>-v<YYYY.MM.DD-N>`, e.g. `docs-v2026.06.28-1`. `N` is a
// same-day counter starting at 1, derived from the existing tags so repeated
// releases on the same day increment automatically.
//
// Usage:
//   node scripts/release.mjs <component> [--dry-run] [--ref <git-ref>]
//
//   <component>   one of: agent, docs, controller
//   --dry-run     print the tag that would be created; do not tag or push
//   --ref <ref>   tag this ref instead of HEAD

const COMPONENTS = new Set(["agent", "docs", "controller"]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function parseArgs(argv) {
  const positional = [];
  let dryRun = false;
  let ref = "HEAD";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--ref") {
      ref = argv[index + 1];
      index += 1;
      if (!ref) fail("--ref requires a value.");
    } else if (arg.startsWith("--")) {
      fail(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  return { component: positional[0], dryRun, ref };
}

function today() {
  const now = new Date();
  const year = now.getFullYear().toString().padStart(4, "0");
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const day = now.getDate().toString().padStart(2, "0");
  return `${year}.${month}.${day}`;
}

function nextCounter(component, date) {
  const prefix = `${component}-v${date}-`;
  const existing = git(["tag", "--list", `${prefix}*`])
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => Number.parseInt(tag.slice(prefix.length), 10))
    .filter((counter) => Number.isInteger(counter) && counter >= 1);

  return existing.length === 0 ? 1 : Math.max(...existing) + 1;
}

const { component, dryRun, ref } = parseArgs(process.argv.slice(2));

if (!component || !COMPONENTS.has(component)) {
  fail(`Usage: node scripts/release.mjs <${[...COMPONENTS].join("|")}> [--dry-run] [--ref <git-ref>]`);
}

const date = today();
const tag = `${component}-v${date}-${nextCounter(component, date)}`;

if (dryRun) {
  console.log(tag);
  process.exit(0);
}

const sha = git(["rev-parse", "--short", ref]);
git(["tag", "-a", tag, ref, "-m", `Release ${component} ${tag.slice(`${component}-v`.length)}`]);
git(["push", "origin", tag]);

console.log(`Created and pushed ${tag} (${sha}). The ${component} release workflow will run.`);
