// @ts-check
import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import remarkDocLinks from "./remark-doc-links.mjs";
import remarkMermaid from "./remark-mermaid.mjs";

// Client-side renderer for the `<pre class="mermaid">` blocks produced by
// remark-mermaid. Lazy-loads mermaid only on pages that have diagrams and
// re-renders when Starlight's light/dark theme changes.
const mermaidClientScript = `
const blocks = [...document.querySelectorAll("pre.mermaid[data-mermaid]")];
if (blocks.length) {
  const { default: mermaid } = await import("mermaid");
  for (const el of blocks) el.dataset.src = el.textContent ?? "";
  const themeOf = () =>
    document.documentElement.dataset.theme === "light" ? "default" : "dark";
  const render = async () => {
    mermaid.initialize({ startOnLoad: false, theme: themeOf() });
    for (const el of blocks) {
      el.removeAttribute("data-processed");
      el.textContent = el.dataset.src ?? "";
    }
    await mermaid.run({ nodes: blocks });
  };
  await render();
  new MutationObserver((mutations) => {
    if (mutations.some((m) => m.attributeName === "data-theme")) render();
  }).observe(document.documentElement, { attributes: true });
}
`;

/** @type {import('astro').AstroIntegration} */
const mermaidIntegration = {
  name: "rakkr-mermaid",
  hooks: {
    "astro:config:setup": ({ injectScript }) => {
      injectScript("page", mermaidClientScript);
    },
  },
};

// https://astro.build/config
export default defineConfig({
  site: "https://docs.rakkr.org",
  markdown: {
    // Astro 7 deprecated `markdown.remarkPlugins`; register plugins on the
    // Unified processor instead. Starlight pushes its own plugins onto this
    // same processor, and gfm/smartypants stay enabled by default.
    processor: unified({
      remarkPlugins: [remarkMermaid, remarkDocLinks],
    }),
  },
  integrations: [
    mermaidIntegration,
    starlight({
      title: "Rakkr",
      description:
        "Reliable room recording for Linux — a centrally managed audio recording platform.",
      favicon: "/favicon.svg",
      logo: {
        // The brand mark (navy tile, white "r", red dot) sits beside the
        // "Rakkr" wordmark, matching the marketing site's nav.
        src: "./src/assets/logo.svg",
        alt: "Rakkr",
        replacesTitle: false,
      },
      components: {
        // Our Markdown bodies open with their own `# H1` (the docs are also
        // rendered on GitHub), so suppress Starlight's duplicate title heading.
        PageTitle: "./src/components/PageTitle.astro",
      },
      // Collapse the now-empty Starlight title panel left by the PageTitle override.
      customCss: ["./src/styles/docs.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/yashau/Rakkr",
        },
      ],
      // Explicit sidebar: Starlight's `autogenerate` does not discover entries
      // loaded through a custom glob loader from outside src/content, so each
      // page is listed by slug.
      sidebar: [
        {
          label: "Getting started",
          items: [
            { label: "Introduction", slug: "getting-started/introduction" },
            { label: "Quick start", slug: "getting-started/quick-start" },
            { label: "Core concepts", slug: "getting-started/concepts" },
          ],
        },
        {
          label: "How-to guides",
          items: [
            { label: "Overview", slug: "how-to" },
            { label: "Get around the console", slug: "how-to/navigate-the-console" },
            { label: "Record a session", slug: "how-to/record-a-session" },
            { label: "Schedule recordings", slug: "how-to/schedule-recordings" },
            { label: "Monitor a room live", slug: "how-to/monitor-rooms-live" },
            { label: "Find & manage recordings", slug: "how-to/manage-recordings" },
            { label: "Track recording jobs", slug: "how-to/track-recording-jobs" },
            { label: "Respond to health alerts", slug: "how-to/respond-to-health-alerts" },
            { label: "Manage rooms", slug: "how-to/manage-rooms" },
            { label: "Grant access to a room", slug: "how-to/grant-room-access" },
            { label: "Enroll & configure nodes", slug: "how-to/enroll-and-configure-nodes" },
            { label: "Manage users", slug: "how-to/manage-users" },
            { label: "Manage groups & access policies", slug: "how-to/manage-groups-and-access" },
            { label: "Configure recording profiles", slug: "how-to/configure-recording-profiles" },
            { label: "Tune watchdog policies", slug: "how-to/tune-watchdog-policies" },
            { label: "Set up storage & uploads", slug: "how-to/set-up-uploads" },
            { label: "Configure channel maps", slug: "how-to/configure-channel-maps" },
            { label: "Set up switcher routing", slug: "how-to/set-up-switcher-routing" },
            { label: "Read the audit log", slug: "how-to/read-the-audit-log" },
          ],
        },
        {
          label: "Architecture",
          items: [
            { label: "Overview", slug: "architecture/overview" },
            { label: "Controller API", slug: "architecture/controller-api" },
            { label: "Recorder agent", slug: "architecture/recorder-agent" },
            { label: "Web console", slug: "architecture/web-console" },
            { label: "Data model", slug: "architecture/data-model" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Authentication & RBAC", slug: "guides/authentication-and-rbac" },
            { label: "Nodes & inventory", slug: "guides/nodes-and-inventory" },
            { label: "Node onboarding", slug: "guides/node-onboarding" },
            { label: "Recording", slug: "guides/recording" },
            { label: "Audio enhancement", slug: "guides/audio-enhancement" },
            { label: "Scheduling", slug: "guides/scheduling" },
            { label: "Health watchdog", slug: "guides/health-watchdog" },
            { label: "Storage & uploads", slug: "guides/storage-and-uploads" },
            { label: "Transport security", slug: "guides/transport-security" },
            { label: "Node lifecycle", slug: "guides/node-lifecycle" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Configuration", slug: "reference/configuration" },
            { label: "Recorder agent CLI", slug: "reference/recorder-agent" },
            { label: "API endpoints", slug: "reference/api" },
            { label: "Permissions", slug: "reference/permissions" },
            { label: "Metrics", slug: "reference/metrics" },
            { label: "Tasks", slug: "reference/tasks" },
          ],
        },
        {
          label: "Operations",
          items: [
            { label: "Deployment", slug: "operations/deployment" },
            { label: "Releases & versioning", slug: "operations/releases" },
            { label: "Observability", slug: "observability" },
          ],
        },
        {
          label: "Contributing",
          items: [
            { label: "Development", slug: "contributing/development" },
            { label: "Testing", slug: "contributing/testing" },
            { label: "Baselines & verification", slug: "contributing/baselines" },
            { label: "Audit & gap-hunt workflow", slug: "contributing/audit-workflow" },
          ],
        },
      ],
    }),
  ],
});
