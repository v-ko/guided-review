import type { Mermaid } from "mermaid";
import { diagramTheme } from "../../media/theme.mjs";
import { matchText } from "./match.mjs";
import type {
  AcceptMessage,
  PromptMessage,
  RenderMessage,
  SelectedText,
  SuggestionView,
} from "./protocol.js";

// The standalone page talks over SSE and POST; a VS Code webview would use postMessage.
interface Host {
  send(message: AcceptMessage | PromptMessage): Promise<string | undefined>;
  listen(listener: (message: RenderMessage) => void): void;
}

function requiredElement<T extends HTMLElement = HTMLElement>(
  id: string,
  type?: new () => T,
): T {
  const element = document.getElementById(id);
  if (!(element instanceof (type ?? HTMLElement)))
    throw new Error(`Missing required element: ${id}`);
  return element as T;
}

const documentView = requiredElement("document");
const suggestionsView = requiredElement("suggestions");
const statusView = requiredElement("status");
const promptForm = requiredElement("prompt", HTMLFormElement);
const promptText = requiredElement("prompt-text", HTMLInputElement);
const promptSend = requiredElement("prompt-send", HTMLButtonElement);
const selectionView = requiredElement("selection");
const selectionSource = requiredElement("selection-source");
const selectionText = requiredElement("selection-text");

const host: Host = {
  async send(message) {
    const response = await fetch(`/${message.type}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    if (response.ok) return undefined;
    const body: unknown = await response.json().catch(() => undefined);
    const error =
      typeof body === "object" && body !== null && "error" in body
        ? body.error
        : undefined;
    return typeof error === "string" ? error : `HTTP ${response.status}`;
  },
  listen(listener) {
    const events = new EventSource("/events");
    events.onopen = () => (statusView.textContent = "");
    events.onerror = () => (statusView.textContent = "Disconnected, retrying…");
    events.onmessage = (event: MessageEvent<string>) =>
      listener(JSON.parse(event.data) as RenderMessage);
  },
};

interface TextIndex {
  text: string;
  nodes: Text[];
  offsets: number[];
}

interface Decoration {
  start: number;
  end: number;
  classes: string[];
  label?: string;
}

function textIndex(root: Element): TextIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(".mermaid-source")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const index: TextIndex = { text: "", nodes: [], offsets: [] };
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    index.nodes.push(text);
    index.offsets.push(index.text.length);
    index.text += text.data;
  }
  return index;
}

/** Finds a quote while ignoring whitespace differences from Markdown rendering. */
function find(
  text: string,
  quote: string,
  from: number,
  minEnd = 0,
): [number, number] | undefined {
  const words = quote
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(words.join("\\s+"), "gu");
  pattern.lastIndex = from;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (m.index + m[0].length >= minEnd)
      return [m.index, m.index + m[0].length];
    pattern.lastIndex = m.index + 1;
  }
  return undefined;
}

function decorate(index: TextIndex, decorations: Decoration[]): void {
  index.nodes.forEach((node, n) => {
    // Whitespace-only nodes sit between block elements, where a mark does not belong.
    if (!node.data.trim()) return;
    const nodeStart = index.offsets[n];
    const length = node.data.length;
    const relevant = decorations.filter(
      (d) => d.start < nodeStart + length && d.end > nodeStart,
    );
    if (!relevant.length) return;
    const cuts = new Set([0, length]);
    for (const d of relevant) {
      cuts.add(Math.max(0, d.start - nodeStart));
      cuts.add(Math.min(length, d.end - nodeStart));
    }
    const points = [...cuts].sort((a, b) => a - b);
    const fragment = document.createDocumentFragment();
    for (let k = 0; k + 1 < points.length; k++) {
      const piece = node.data.slice(points[k], points[k + 1]);
      const at = nodeStart + points[k];
      const covering = relevant.filter((d) => d.start <= at && d.end > at);
      if (!covering.length) {
        fragment.append(piece);
        continue;
      }
      const mark = document.createElement("mark");
      mark.className = covering.flatMap((d) => d.classes).join(" ");
      const label = covering.find((d) => d.label && d.start === at)?.label;
      if (label) mark.dataset.label = label;
      mark.textContent = piece;
      fragment.append(mark);
    }
    node.replaceWith(fragment);
  });
}

function card(
  suggestion: SuggestionView,
  fingerprint: string,
): { element: HTMLElement; replacement: HTMLElement } {
  const element = document.createElement("article");
  const replaces = suggestion.from !== undefined;
  element.className = replaces ? "card" : "card insert";
  element.dataset.id = suggestion.id;
  const header = document.createElement("header");
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = suggestion.id;
  const anchor = document.createElement("span");
  anchor.className = "anchor";
  anchor.textContent = replaces
    ? `Replaces “${suggestion.from}” … “${suggestion.to}”`
    : suggestion.after !== undefined
      ? `Inserts after “${suggestion.after}”`
      : "Appends to the end";
  header.append(badge, anchor);
  const replacement = document.createElement("div");
  replacement.className = "markdown replacement";
  replacement.innerHTML = suggestion.html; // Rendered by the server with Markdown HTML disabled.
  element.append(header, replacement);
  if (suggestion.problems.length) {
    const problems = document.createElement("ul");
    problems.className = "problems";
    for (const problem of suggestion.problems) {
      const item = document.createElement("li");
      item.textContent = problem;
      problems.append(item);
    }
    element.append(problems);
  }
  const accept = document.createElement("button");
  accept.textContent = "Accept";
  accept.disabled = suggestion.problems.length > 0;
  accept.addEventListener("click", async () => {
    accept.disabled = true;
    statusView.textContent = "Applying…";
    const error = await host
      .send({ type: "accept", id: suggestion.id, fingerprint })
      .catch((reason: unknown) => String(reason));
    statusView.textContent = error ?? "";
    if (error) accept.disabled = false;
  });
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(accept);
  element.append(actions);
  return { element, replacement };
}

/** Marks where an insertion lands: after its quote, or at the end of the document. */
function insertMarker(suggestion: SuggestionView): void {
  const marker = document.createElement("span");
  marker.className = "insertion";
  marker.dataset.label = suggestion.id;
  if (suggestion.after === undefined) {
    documentView.append(marker);
    return;
  }
  // Re-indexed per marker: decorations and earlier markers split text nodes.
  const index = textIndex(documentView);
  const found = find(index.text, suggestion.after, 0);
  if (!found) return;
  let n = 0;
  while (n + 1 < index.nodes.length && index.offsets[n + 1] < found[1]) n++;
  index.nodes[n].splitText(found[1] - index.offsets[n]);
  index.nodes[n].after(marker);
}

let mermaid: Mermaid | undefined;
let chartId = 0;
let revision = 0;
let latest: RenderMessage | undefined;
let pending: RenderMessage | undefined;
let rendering = false;

async function diagrams(currentRevision: number): Promise<void> {
  const nodes = [...document.querySelectorAll<HTMLElement>(".mermaid-source")];
  if (!nodes.length) return;
  try {
    if (!mermaid) {
      const url = requiredElement("client").dataset.mermaid;
      if (!url) throw new Error("Missing Mermaid resource URL");
      mermaid = ((await import(url)) as { default: Mermaid }).default;
    }
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      ...diagramTheme(getComputedStyle(document.body), document.body.classList),
      maxTextSize: 20000,
      maxEdges: 200,
      secure: [
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "maxEdges",
        "themeCSS",
        "fontFamily",
        "themeVariables",
      ],
    });
    for (const node of nodes) {
      if (revision !== currentRevision) return;
      const source = node.textContent ?? "";
      // Documents supply diagram syntax, not renderer configuration.
      if (/%%\s*\{/.test(source) || /^\s*---/.test(source)) {
        node.textContent =
          "Diagram configuration directives are disabled.\n\n" + source;
        continue;
      }
      try {
        const { svg } = await mermaid.render(
          `layout-suggest-diagram-${++chartId}`,
          source,
        );
        if (revision !== currentRevision) return;
        const wrapper = document.createElement("div");
        wrapper.className = "diagram";
        wrapper.innerHTML = svg; // Mermaid strict-mode sanitized output.
        node.replaceWith(wrapper);
      } catch {
        node.classList.add("diagram-error");
        node.textContent = "Unable to render diagram. Source:\n\n" + source;
      }
    }
  } catch {
    for (const node of nodes)
      node.textContent =
        "Mermaid could not load. Source:\n\n" + node.textContent;
  }
}

async function render(
  message: RenderMessage,
  currentRevision: number,
): Promise<void> {
  const scroll = [documentView.scrollTop, suggestionsView.scrollTop];
  statusView.textContent = "";
  documentView.innerHTML = message.document; // Rendered by the server with Markdown HTML disabled.
  const cards = message.suggestions.map((s) => card(s, message.fingerprint));
  if (cards.length)
    suggestionsView.replaceChildren(...cards.map((c) => c.element));
  else {
    const ok = document.createElement("p");
    ok.className = "ok";
    ok.textContent = "OK";
    suggestionsView.replaceChildren(ok);
  }

  const index = textIndex(documentView);
  const decorations: Decoration[] = [];
  let color = 0;
  message.suggestions.forEach((suggestion, i) => {
    const { from, to } = suggestion;
    if (suggestion.problems.length || from === undefined || to === undefined)
      return;
    const start = find(index.text, from, 0);
    const end = start && find(index.text, to, start[0], start[1]);
    if (!start || !end) return;
    decorations.push({
      start: start[0],
      end: end[1],
      classes: ["covered"],
      label: suggestion.id,
    });
    const cardIndex = textIndex(cards[i].replacement);
    const cardDecorations: Decoration[] = [];
    for (const match of matchText(
      index.text.slice(start[0], end[1]),
      cardIndex.text,
    )) {
      const classes = ["match", `c${color++ % 8}`];
      decorations.push({
        start: start[0] + match.source[0],
        end: start[0] + match.source[1],
        classes,
      });
      cardDecorations.push({
        start: match.target[0],
        end: match.target[1],
        classes,
      });
    }
    decorate(cardIndex, cardDecorations);
  });
  decorate(index, decorations);
  for (const suggestion of message.suggestions)
    if (!suggestion.problems.length && suggestion.from === undefined)
      insertMarker(suggestion);
  [documentView.scrollTop, suggestionsView.scrollTop] = scroll;
  await diagrams(currentRevision);
}

async function drain(): Promise<void> {
  if (rendering) return;
  rendering = true;
  try {
    // Mermaid's shared configuration must not race a newer render.
    while (pending) {
      const message = pending;
      const currentRevision = revision;
      pending = undefined;
      await render(message, currentRevision);
    }
  } finally {
    rendering = false;
  }
}

function queueRender(message: RenderMessage): void {
  latest = pending = message;
  revision++;
  void drain();
}

// Standalone stand-in for the theme classes VS Code puts on webview bodies.
const dark = matchMedia("(prefers-color-scheme: dark)");
function applyScheme(): void {
  document.body.classList.toggle("vscode-dark", dark.matches);
  document.body.classList.toggle("vscode-light", !dark.matches);
}
applyScheme();
dark.addEventListener("change", () => {
  applyScheme();
  if (latest) queueRender(latest);
});

// Kept after focus moves to the prompt field, which takes the page selection away.
let selected: SelectedText | undefined;

function showSelection(): void {
  selectionView.hidden = !selected;
  selectionSource.textContent = selected ? `${selected.source}:` : "";
  selectionText.textContent = selected?.text ?? "";
}

document.addEventListener("selectionchange", () => {
  const selection = document.getSelection();
  const node = selection?.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;
  const source = element?.closest("#document")
    ? "document"
    : element?.closest<HTMLElement>(".card")?.dataset.id;
  if (!selection || !source) return;
  const text = selection.toString().trim();
  selected = text ? { text, source } : undefined;
  showSelection();
});

requiredElement("selection-clear").addEventListener("click", () => {
  selected = undefined;
  showSelection();
});

promptForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = promptText.value.trim();
  if (!text) return;
  promptSend.disabled = true;
  statusView.textContent = "Sending…";
  const error = await host
    .send({ type: "prompt", text, ...(selected && { selection: selected }) })
    .catch((reason: unknown) => String(reason));
  promptSend.disabled = false;
  statusView.textContent = error ?? "Sent, waiting for new suggestions…";
  if (error) return;
  promptText.value = "";
  selected = undefined;
  showSelection();
});

host.listen(queueRender);
