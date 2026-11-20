function frameSource(source: string, base: string): string {
  const parsed = new DOMParser().parseFromString(source, "text/html");
  for (const element of parsed.querySelectorAll("base, meta[http-equiv]"))
    element.remove();
  // A written document does not inherit the review's policy. This one allows
  // inline code and files VS Code serves from the workspace, nothing remote.
  const url = new URL(base);
  // VS Code serves files from hosts like file+.vscode-resource.vscode-cdn.net,
  // but a policy host cannot contain "+": allow that resource domain instead.
  const files = /^[a-z0-9.-]+$/i.test(url.hostname)
    ? url.origin
    : `${url.protocol}//*.${url.host.split(".").slice(1).join(".")}`;
  const policy = parsed.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content =
    `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' ${files}; ` +
    `style-src 'unsafe-inline' ${files}; img-src ${files} data: blob:; ` +
    `font-src ${files} data:; media-src ${files} data: blob:; ` +
    `connect-src ${files}; frame-src 'none'; worker-src 'none'; ` +
    `object-src 'none'; base-uri ${files}; form-action 'none';`;
  parsed.head.prepend(policy);
  // Creating <base> in the parsed document would trip the review's base-uri
  // rule, so add it to the serialized page instead.
  const baseTag = `<base href="${base.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`;
  return (
    "<!doctype html>\n" +
    parsed.documentElement.outerHTML.replace(
      /<head[^>]*>/,
      (head) => head + baseTag,
    )
  );
}

/** Starts embeds without a frame and wires their Reload buttons. */
export function startEmbeds(root: HTMLElement): void {
  for (const embed of root.querySelectorAll<HTMLElement>(
    ".review-html[data-embed-key]",
  )) {
    const view = embed.querySelector<HTMLElement>(".embed-view")!;
    if (view.firstChild) continue;
    embed
      .querySelector<HTMLButtonElement>('[data-embed-action="reload"]')!
      .addEventListener("click", () => run(embed, view));
    run(embed, view);
  }
}

function run(embed: HTMLElement, view: HTMLElement): void {
  const status = embed.querySelector<HTMLElement>(".embed-status")!;
  try {
    const source = frameSource(
      embed.dataset.embedHtml!,
      embed.dataset.embedBase!,
    );
    const frame = document.createElement("iframe");
    frame.title = embed.dataset.embedTitle!;
    frame.height = embed.dataset.embedHeight!;
    // Same origin lets VS Code serve relative files. It is a separate
    // window, so page errors and globals do not affect the review.
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.referrerPolicy = "no-referrer";
    // VS Code serves files only to documents whose URL has the webview id,
    // which srcdoc lacks. Load its empty page, as VS Code does, then write.
    let written = false;
    frame.addEventListener("load", () => {
      const target = frame.contentDocument;
      if (written || !target || target.URL === "about:blank") return;
      written = true;
      setTimeout(() => {
        if (!frame.isConnected) return;
        target.open();
        target.write(source);
        target.close();
      });
    });
    const id = new URLSearchParams(location.search).get("id") ?? "";
    frame.src = new URL(
      `fake.html?${new URLSearchParams({ id })}`,
      location.href,
    ).href;
    view.replaceChildren(frame);
    if (frame.contentWindow) embedWindows.add(frame.contentWindow);
    status.hidden = true;
  } catch (error) {
    status.textContent = `Unable to run interactive HTML: ${String(error)}`;
    status.hidden = false;
  }
}

// Removed frames can still deliver queued messages, for example from unload.
const embedWindows = new WeakSet<object>();

/** Whether a message came from an embedded page rather than VS Code. */
export function fromEmbed(source: MessageEventSource | null): boolean {
  return !!source && embedWindows.has(source);
}

/** Like replaceChildren, but moves running embeds with the same key instead of restarting them. */
export function replaceKeepingFrames(
  live: HTMLElement,
  next: HTMLElement,
): void {
  const oldChildren = [...live.childNodes];
  const existing = new Map<string, HTMLElement[]>();
  for (const embed of live.querySelectorAll<HTMLElement>("[data-embed-key]")) {
    const key = embed.dataset.embedKey!;
    const matches = existing.get(key) ?? [];
    matches.push(embed);
    existing.set(key, matches);
  }
  const replacements = [
    ...next.querySelectorAll<HTMLElement>("[data-embed-key]"),
  ];
  live.append(...next.childNodes);
  for (const replacement of replacements) {
    const previous = existing.get(replacement.dataset.embedKey!)?.shift();
    const parent = replacement.parentElement!;
    if (previous && typeof parent.moveBefore === "function") {
      parent.moveBefore(previous, replacement);
      replacement.remove();
    }
  }
  for (const child of oldChildren) child.remove();
}
