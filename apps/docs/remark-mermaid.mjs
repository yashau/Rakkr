// Converts ```mermaid fenced code blocks into raw `<pre class="mermaid">` HTML
// so Expressive Code leaves them alone and the client script (see astro.config)
// can render them with mermaid.js. The diagram source is HTML-escaped; the
// client reads it back via textContent.

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default function remarkMermaid() {
  return (tree) => {
    const transform = (node) => {
      if (!node || !Array.isArray(node.children)) return;
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child.type === "code" && child.lang === "mermaid") {
          node.children[i] = {
            type: "html",
            value: `<pre class="mermaid" data-mermaid>${escapeHtml(child.value)}</pre>`,
          };
        } else {
          transform(child);
        }
      }
    };
    transform(tree);
  };
}
