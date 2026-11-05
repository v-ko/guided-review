import MarkdownIt from "markdown-it";

export function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (c) => entities[c]);
}

/** Renders untrusted Markdown the same way Guided Code Review does. */
export function renderMarkdown(text: string): string {
  const md = new MarkdownIt({ html: false, linkify: false, breaks: false });
  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, index, options, env, renderer) =>
    tokens[index].info.trim() === "mermaid"
      ? `<pre class="mermaid-source">${escapeHtml(tokens[index].content)}</pre>`
      : fence(tokens, index, options, env, renderer);
  // Documents cannot embed remote images or navigate the page.
  md.renderer.rules.image = (tokens, index) =>
    `<span class="image-placeholder">[Image: ${escapeHtml(tokens[index].content)}]</span>`;
  md.renderer.rules.link_open = () => '<span class="document-link">';
  md.renderer.rules.link_close = () => "</span>";
  return md.render(text);
}
